import {
  ItemView,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type {
  HistorySourceProbe,
  HistorySourceSnapshot,
  HistorySourceVersion
} from "../history-sources/types";
import { ConfirmActionModal } from "../ui/confirm-modal";
import { tr } from "../i18n";

export const GIT_HISTORY_SOURCE_VIEW_TYPE = "git-note-history-sources";

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function sourceIcon(probe: HistorySourceProbe): string {
  switch (probe.descriptor.kind) {
    case "git": return "git-commit-horizontal";
    case "workspace": return "file-pen-line";
    case "local-snapshot": return "camera";
    case "file-recovery": return "history";
    case "sync": return "cloud";
  }
}

function sourceStatus(probe: HistorySourceProbe): string {
  if (probe.status === "ready") return tr(`${probe.versions.length} 个版本`, `${probe.versions.length} versions`);
  if (probe.status === "empty") return tr("暂无版本", "No versions yet");
  if (probe.status === "handoff") return tr("由 Obsidian 管理", "Managed by Obsidian");
  if (probe.status === "error") return tr("读取失败", "Could not read");
  return tr("当前不可用", "Unavailable now");
}

export class GitHistorySourceView extends ItemView {
  private targetFile: TFile | null = null;
  private snapshot: HistorySourceSnapshot | null = null;
  private loading = false;
  private error = "";
  private generation = 0;
  private controller: AbortController | null = null;
  private visibleVersionCount = 30;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitNoteHistoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_HISTORY_SOURCE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return tr("历史来源", "History sources");
  }

  getIcon(): string {
    return "layers-3";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.path === this.targetFile?.path) {
        void this.refresh();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || oldPath !== this.targetFile?.path) return;
      this.targetFile = file;
      void this.refresh();
    }));
    this.render();
  }

  async onClose(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
  }

  async setFile(file: TFile): Promise<void> {
    if (file.path !== this.targetFile?.path) this.visibleVersionCount = 30;
    this.targetFile = file;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const file = this.targetFile;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    this.render();
    if (!file) {
      this.loading = false;
      this.render();
      return;
    }
    try {
      const snapshot = await this.plugin.loadHistorySources(file, controller.signal);
      if (generation !== this.generation) return;
      this.snapshot = snapshot;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "git-note-history-source-view");
    this.renderHeader(container);

    if (!this.targetFile) {
      this.renderEmpty(container, "file-text", tr("请先打开一篇 Markdown 笔记", "Open a Markdown note first"));
      return;
    }
    if (this.loading && !this.snapshot) {
      this.renderEmpty(container, "loader-circle", tr("正在检查各个历史来源", "Checking each history source"));
      return;
    }
    if (this.error) {
      this.renderEmpty(container, "triangle-alert", this.error);
      return;
    }
    if (!this.snapshot) return;

    const grid = container.createDiv({ cls: "git-note-history-source-grid" });
    for (const probe of this.snapshot.probes) this.renderProbe(grid, probe);

    const directVersions = this.snapshot.versions.filter(
      (version) => version.source !== "workspace"
    );
    const section = container.createDiv({ cls: "git-note-history-source-timeline" });
    const title = section.createDiv({ cls: "git-note-history-source-section-title" });
    title.createEl("h3", { text: tr("可直接比较的版本", "Versions you can compare directly") });
    title.createSpan({
      text: directVersions.length
        ? tr(`${directVersions.length} 个版本，按真实时间混合排列`, `${directVersions.length} versions, mixed in real time order`)
        : tr("当前没有可直接比较的历史版本", "No past versions to compare directly yet")
    });
    const visibleVersions = directVersions.slice(0, this.visibleVersionCount);
    for (const version of visibleVersions) this.renderVersion(section, version);
    if (visibleVersions.length < directVersions.length) {
      const footer = section.createDiv({
        cls: "git-note-history-source-timeline-footer"
      });
      footer.createSpan({
        text: tr(`已显示 ${visibleVersions.length} / ${directVersions.length}`, `Showing ${visibleVersions.length} / ${directVersions.length}`)
      });
      const more = footer.createEl("button", { text: tr("再显示 30 个", "Show 30 more") });
      more.addEventListener("click", () => {
        this.visibleVersionCount += 30;
        this.render();
      });
    }
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "git-note-history-source-header" });
    const title = header.createDiv();
    title.createEl("h2", { text: tr("历史来源", "History sources") });
    title.createDiv({
      cls: "git-note-history-source-path",
      text: this.targetFile?.path ?? tr("尚未选择笔记", "No note chosen yet")
    });
    const actions = header.createDiv({ cls: "git-note-history-source-actions" });
    if (this.targetFile) {
      const capture = actions.createEl("button", {
        cls: "mod-cta",
        text: tr("保存本地快照", "Save a local snapshot")
      });
      const icon = capture.createSpan();
      capture.prepend(icon);
      setIcon(icon, "camera");
      capture.addEventListener("click", () => void this.captureSnapshot());
    }
    const refresh = actions.createEl("button", {
      attr: {
        "aria-label": this.loading ? tr("正在刷新", "Refreshing") : tr("刷新历史来源", "Refresh history sources"),
        "aria-busy": String(this.loading)
      }
    });
    refresh.disabled = this.loading;
    setIcon(refresh, this.loading ? "loader-circle" : "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());
  }

  private renderProbe(container: HTMLElement, probe: HistorySourceProbe): void {
    const card = container.createDiv({
      cls: `git-note-history-source-card is-${probe.status}`
    });
    const heading = card.createDiv({ cls: "git-note-history-source-card-heading" });
    const identity = heading.createDiv({ cls: "git-note-history-source-identity" });
    setIcon(identity.createSpan(), sourceIcon(probe));
    identity.createEl("h3", { text: probe.descriptor.label });
    heading.createSpan({
      cls: "git-note-history-source-badge",
      text: sourceStatus(probe)
    });
    card.createDiv({
      cls: "git-note-history-source-description",
      text: probe.descriptor.description
    });
    card.createDiv({
      cls: "git-note-history-source-summary",
      text: probe.summary
    });
    if (probe.descriptor.retentionLabel) {
      card.createDiv({
        cls: "git-note-history-source-boundary",
        text: tr(`保留：${probe.descriptor.retentionLabel}`, `Kept: ${probe.descriptor.retentionLabel}`)
      });
    }
    if (probe.descriptor.boundary) {
      card.createDiv({
        cls: "git-note-history-source-boundary",
        text: probe.descriptor.boundary
      });
    }
    if (probe.error) {
      const details = card.createEl("details");
      details.createEl("summary", { text: tr("查看错误", "View error") });
      details.createEl("pre", { text: probe.error });
    }
  }

  private renderVersion(
    container: HTMLElement,
    version: HistorySourceVersion
  ): void {
    const row = container.createDiv({ cls: "git-note-history-source-version" });
    const main = row.createDiv({ cls: "git-note-history-source-version-main" });
    const title = main.createDiv({ cls: "git-note-history-source-version-title" });
    title.createSpan({
      cls: `git-note-history-source-dot is-${version.source}`
    });
    title.createSpan({ text: version.label });
    main.createDiv({
      cls: "git-note-history-source-version-meta",
      text: `${timeLabel(version.capturedAt)}${version.detail ? ` · ${version.detail}` : ""}`
    });
    const actions = row.createDiv({ cls: "git-note-history-source-version-actions" });
    if (version.comparisonAvailable) {
      const compare = actions.createEl("button", { text: tr("与当前比较", "Compare with now") });
      compare.addEventListener("click", () => {
        void this.plugin.openHistorySourceVersion(this.targetFile!, version)
          .catch((error: unknown) => {
            new Notice(error instanceof Error ? error.message : String(error), 8000);
          });
      });
    }
    if (version.source === "local-snapshot") {
      const remove = actions.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": tr("删除这个本地快照", "Delete this local snapshot") }
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", () => {
        new ConfirmActionModal(
          this.app,
          tr("删除本地快照？", "Delete the local snapshot?"),
          tr(`将永久删除“${version.label}”。不会修改笔记或 Git 历史。`, `"${version.label}" will be deleted for good. The note and Git history do not change.`),
          tr("删除快照", "Delete snapshot"),
          async () => {
            await this.plugin.deleteLocalSnapshot(
              version.sourceReference ?? version.id.replace(/^local-snapshot:/u, "")
            );
            await this.refresh();
          },
          true
        ).open();
      });
    }
  }

  private async captureSnapshot(): Promise<void> {
    if (!this.targetFile) return;
    try {
      const result = await this.plugin.captureLocalSnapshot(this.targetFile);
      new Notice(result.created ? tr("已保存本地快照。", "Local snapshot saved.") : tr("相同内容的快照已经存在。", "A snapshot with the same content already exists."));
      await this.refresh();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private renderEmpty(
    container: HTMLElement,
    iconName: string,
    text: string
  ): void {
    const empty = container.createDiv({ cls: "git-note-history-source-empty" });
    setIcon(empty.createSpan(), iconName);
    empty.createDiv({ text });
  }
}
