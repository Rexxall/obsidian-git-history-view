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
  if (probe.status === "ready") return `${probe.versions.length} 个版本`;
  if (probe.status === "empty") return "暂无版本";
  if (probe.status === "handoff") return "由 Obsidian 管理";
  if (probe.status === "error") return "读取失败";
  return "当前不可用";
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
    return "历史来源";
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
    container.addClass("git-note-history-source-view");
    this.renderHeader(container);

    if (!this.targetFile) {
      this.renderEmpty(container, "file-text", "请先打开一篇 Markdown 笔记");
      return;
    }
    if (this.loading && !this.snapshot) {
      this.renderEmpty(container, "loader-circle", "正在检查各个历史来源");
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
    title.createEl("h3", { text: "可直接比较的版本" });
    title.createSpan({
      text: directVersions.length
        ? `${directVersions.length} 个版本，按真实时间混合排列`
        : "当前没有可直接比较的历史版本"
    });
    const visibleVersions = directVersions.slice(0, this.visibleVersionCount);
    for (const version of visibleVersions) this.renderVersion(section, version);
    if (visibleVersions.length < directVersions.length) {
      const footer = section.createDiv({
        cls: "git-note-history-source-timeline-footer"
      });
      footer.createSpan({
        text: `已显示 ${visibleVersions.length} / ${directVersions.length}`
      });
      const more = footer.createEl("button", { text: "再显示 30 个" });
      more.addEventListener("click", () => {
        this.visibleVersionCount += 30;
        this.render();
      });
    }
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "git-note-history-source-header" });
    const title = header.createDiv();
    title.createEl("h2", { text: "历史来源" });
    title.createDiv({
      cls: "git-note-history-source-path",
      text: this.targetFile?.path ?? "尚未选择笔记"
    });
    const actions = header.createDiv({ cls: "git-note-history-source-actions" });
    if (this.targetFile) {
      const capture = actions.createEl("button", {
        cls: "mod-cta",
        text: "保存本地快照"
      });
      const icon = capture.createSpan();
      capture.prepend(icon);
      setIcon(icon, "camera");
      capture.addEventListener("click", () => void this.captureSnapshot());
    }
    const refresh = actions.createEl("button", {
      attr: {
        "aria-label": this.loading ? "正在刷新" : "刷新历史来源",
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
        text: `保留：${probe.descriptor.retentionLabel}`
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
      details.createEl("summary", { text: "查看错误" });
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
      const compare = actions.createEl("button", { text: "与当前比较" });
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
        attr: { "aria-label": "删除这个本地快照" }
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", () => {
        new ConfirmActionModal(
          this.app,
          "删除本地快照？",
          `将永久删除“${version.label}”。不会修改笔记或 Git 历史。`,
          "删除快照",
          async () => {
            await this.plugin.deleteLocalSnapshot(
              version.sourceReference ?? version.id.replace(/^local-snapshot:/u, "")
            );
            await this.refresh();
          }
        ).open();
      });
    }
  }

  private async captureSnapshot(): Promise<void> {
    if (!this.targetFile) return;
    try {
      const result = await this.plugin.captureLocalSnapshot(this.targetFile);
      new Notice(result.created ? "已保存本地快照。" : "相同内容的快照已经存在。");
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
