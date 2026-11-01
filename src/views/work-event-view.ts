import { diffLines, diffWordsWithSpace } from "diff";
import {
  ItemView,
  Notice,
  setIcon,
  WorkspaceLeaf
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import {
  groupWorkEventFiles,
  shouldRenderWorkEventSearch,
  workEventMetrics
} from "../work-events/work-event";
import type {
  WorkEventFileChange,
  WorkEventRelationDelta,
  WorkEventRequest,
  WorkEventSnapshot
} from "../work-events/types";
import { tr } from "../i18n";

export const GIT_WORK_EVENT_VIEW_TYPE = "git-work-event-view";

interface CompactChangeGroup {
  removed: string[];
  added: string[];
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function compactPath(value: string): { folder: string; name: string } {
  const parts = value.split("/");
  const name = parts.pop() ?? value;
  return { folder: parts.join("/"), name };
}

function statusLabel(change: WorkEventFileChange): string {
  if (change.netUnchanged) return tr("会话内改后还原", "Changed and changed back");
  if (change.conflicted || change.status === "U") return tr("冲突", "Conflict");
  if (change.untracked) return tr("未跟踪", "Untracked");
  return {
    A: tr("新增", "Added"),
    C: tr("复制", "Copied"),
    D: tr("删除", "Deleted"),
    M: tr("修改", "Modified"),
    R: tr("重命名", "Renamed"),
    T: tr("类型变化", "Type changed"),
    U: tr("冲突", "Conflict")
  }[change.status];
}

function statusIcon(change: WorkEventFileChange): string {
  if (change.conflicted || change.status === "U") return "triangle-alert";
  return {
    A: "file-plus-2",
    C: "copy",
    D: "file-x-2",
    M: "file-pen-line",
    R: "folder-input",
    T: "replace",
    U: "triangle-alert"
  }[change.status];
}

function sourceCopy(snapshot: WorkEventSnapshot): {
  title: string;
  label: string;
  description: string;
} {
  if (snapshot.source === "working") {
    return {
      title: tr("当前未提交工作", "Current uncommitted work"),
      label: tr("打开时快照", "Snapshot when opened"),
      description: tr(`${snapshot.branch} · 采样于 ${formatEventTime(snapshot.capturedAt)}`, `${snapshot.branch} · sampled ${formatEventTime(snapshot.capturedAt)}`)
    };
  }
  const head = snapshot.commits[0];
  if (snapshot.source === "git-session") {
    return {
      title: head?.subject || tr("跨文件编辑会话", "Editing session across files"),
      label: tr("推测会话", "Inferred session"),
      description: tr(`${snapshot.branch} · ${snapshot.commits.length} 个连续自动备份 · ${formatEventTime(snapshot.startedAt ?? snapshot.endedAt)} 至 ${formatEventTime(snapshot.endedAt)}`, `${snapshot.branch} · ${snapshot.commits.length} automatic backups in a row · ${formatEventTime(snapshot.startedAt ?? snapshot.endedAt)} to ${formatEventTime(snapshot.endedAt)}`)
    };
  }
  return {
    title: head?.subject || tr("本次 Git 提交", "This Git commit"),
    label: tr("精确提交", "Exact commit"),
    description: `${snapshot.branch} · ${head?.shortHash ?? snapshot.headHash?.slice(0, 7) ?? ""} · ${formatEventTime(snapshot.endedAt)}`
  };
}

function compactChangeGroups(before: string, after: string): CompactChangeGroup[] {
  const withoutBlankLines = (content: string): string =>
    content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .join("\n");
  const groups: CompactChangeGroup[] = [];
  let current: CompactChangeGroup | null = null;
  const finish = (): void => {
    if (!current) return;
    groups.push(current);
    current = null;
  };
  for (const part of diffLines(withoutBlankLines(before), withoutBlankLines(after))) {
    if (!part.added && !part.removed) {
      finish();
      continue;
    }
    current ??= { removed: [], added: [] };
    const lines = part.value.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    if (part.removed) current.removed.push(...lines);
    if (part.added) current.added.push(...lines);
  }
  finish();
  return groups;
}

export class GitWorkEventView extends ItemView {
  private request: WorkEventRequest | null = null;
  private snapshot: WorkEventSnapshot | null = null;
  private selectedKey = "";
  private query = "";
  private loading = false;
  private error = "";
  private generation = 0;
  private resizeObserver: ResizeObserver | null = null;
  private narrow = false;
  private detailOpen = false;
  private visibleFileLimit = 200;
  private masterScrollTop = 0;
  private filterTimer: number | null = null;
  private readonly diffCache = new Map<string, CompactChangeGroup[]>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitNoteHistoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_WORK_EVENT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.snapshot?.source === "working" ? tr("当前未提交工作", "Current uncommitted work") : tr("工作事件", "Work event");
  }

  getIcon(): string {
    return "git-pull-request-arrow";
  }

  async onOpen(): Promise<void> {
    this.narrow = this.contentEl.clientWidth <= 720;
    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? this.contentEl.clientWidth;
      const nextNarrow = width <= 720;
      if (nextNarrow === this.narrow) return;
      this.narrow = nextNarrow;
      this.render();
    });
    this.resizeObserver.observe(this.contentEl);
    this.registerDomEvent(this.contentEl, "keydown", (event) => {
      if (event.key === "Escape" && this.narrow && this.detailOpen) {
        event.preventDefault();
        this.returnToMaster();
        return;
      }
      const target = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(".git-work-event-file")
        : null;
      if (!target || !["ArrowDown", "ArrowUp", "j", "k"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...this.contentEl.querySelectorAll<HTMLButtonElement>(
        ".git-work-event-file"
      )];
      const index = buttons.indexOf(target);
      const direction = event.key === "ArrowDown" || event.key === "j" ? 1 : -1;
      buttons[index + direction]?.focus();
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
    this.filterTimer = null;
    this.generation += 1;
  }

  async setRequest(request: WorkEventRequest): Promise<void> {
    if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
    this.filterTimer = null;
    this.request = request;
    this.snapshot = null;
    this.selectedKey = "";
    this.query = "";
    this.detailOpen = false;
    this.visibleFileLimit = 200;
    this.masterScrollTop = 0;
    this.diffCache.clear();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.request) return;
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const snapshot = await this.plugin.gitClient.loadWorkEvent(this.request);
      if (generation !== this.generation) return;
      this.snapshot = snapshot;
      this.diffCache.clear();
      const initial = snapshot.netChanges.find((change) => change.isAnchor)
        ?? snapshot.netChanges[0];
      this.selectedKey = initial ? this.changeKey(initial) : "";
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private changeKey(change: WorkEventFileChange): string {
    return `${change.status}\u001f${change.originalRepositoryPath ?? ""}\u001f${change.repositoryPath}`;
  }

  private render(): void {
    if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
    this.filterTimer = null;
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "git-work-event-view");
    container.toggleClass("is-narrow", this.narrow);
    container.toggleClass("is-detail-open", this.detailOpen);
    this.renderHeader(container);

    if (this.loading) {
      const loading = container.createDiv({
        cls: "git-work-event-state is-loading",
        attr: { role: "status", "aria-live": "polite" }
      });
      setIcon(loading.createSpan(), "loader-circle");
      loading.createDiv({ text: tr("正在读取这次工作涉及的文件与关系…", "Reading the files and relations in this piece of work…") });
      return;
    }
    if (this.error) {
      const state = container.createDiv({
        cls: "git-work-event-state is-error",
        attr: { role: "alert" }
      });
      setIcon(state.createSpan(), "triangle-alert");
      const copy = state.createDiv();
      copy.createEl("strong", { text: tr("无法读取工作事件", "Could not read the work event") });
      copy.createDiv({ text: this.error });
      const retry = copy.createEl("button", { text: tr("重试", "Try again") });
      retry.addEventListener("click", () => void this.refresh());
      return;
    }
    if (!this.snapshot) {
      container.createDiv({
        cls: "git-work-event-state",
        text: tr("请从 Git 时间线选择一次工作事件。", "Choose a work event from the Git timeline."),
        attr: { role: "status" }
      });
      return;
    }
    this.renderWarnings(container, this.snapshot);
    if (this.snapshot.netChanges.length === 0) {
      const empty = container.createDiv({
        cls: "git-work-event-state",
        attr: { role: "status" }
      });
      setIcon(empty.createSpan(), "circle-check");
      empty.createDiv({
        text: this.snapshot.source === "working"
          ? tr("当前工作区没有未提交改动。", "The working copy has no uncommitted edits.")
          : tr("这个提交没有可展示的 Vault 内文件变化。", "This commit changes no files inside the vault that can be shown.")
      });
      return;
    }
    const layout = container.createDiv({ cls: "git-work-event-layout" });
    this.renderMaster(layout, this.snapshot);
    this.renderDetail(layout, this.snapshot);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "git-work-event-header" });
    const identity = header.createDiv({ cls: "git-work-event-identity" });
    const eyebrow = identity.createDiv({ cls: "git-work-event-eyebrow" });
    setIcon(eyebrow.createSpan(), "git-pull-request-arrow");
    eyebrow.createSpan({ text: tr("工作事件", "Work event") });
    if (this.snapshot) {
      const source = sourceCopy(this.snapshot);
      eyebrow.createSpan({
        cls: `git-work-event-source is-${this.snapshot.confidence}`,
        text: source.label
      });
      identity.createEl("h2", { text: source.title });
      identity.createDiv({ cls: "git-work-event-description", text: source.description });
      this.renderMetrics(header, this.snapshot);
    } else {
      identity.createEl("h2", { text: tr("工作事件", "Work event") });
      identity.createDiv({
        cls: "git-work-event-description",
        text: tr("查看一次提交、编辑会话或当前工作区涉及的全部 Vault 文件。", "See every vault file touched by a commit, an editing session or the working copy.")
      });
    }
    const actions = header.createDiv({ cls: "git-work-event-header-actions" });
    const refresh = actions.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": this.snapshot?.source === "working"
          ? tr("重新采样当前工作区", "Sample the working copy again")
          : tr("重新读取工作事件", "Read the work event again")
      }
    });
    setIcon(refresh, "refresh-cw");
    refresh.disabled = this.loading || !this.request;
    refresh.addEventListener("click", () => void this.refresh());
  }

  private renderMetrics(container: HTMLElement, snapshot: WorkEventSnapshot): void {
    const metrics = workEventMetrics(snapshot.netChanges, snapshot.relationDeltas.length);
    const row = container.createDiv({ cls: "git-work-event-metrics" });
    const values = [
      ["files", `${metrics.files}`, tr("文件", "files")],
      ["notes", `${metrics.notes}`, tr("笔记", "notes")],
      ["lines", `+${metrics.addedLines} / −${metrics.deletedLines}`, tr("行", "lines")],
      ["links", `${metrics.relationChanges}`, tr("关系", "relations")]
    ] as const;
    for (const [key, value, label] of values) {
      const metric = row.createDiv({ cls: `git-work-event-metric is-${key}` });
      metric.createSpan({ cls: "git-work-event-metric-value", text: value });
      metric.createSpan({ cls: "git-work-event-metric-label", text: label });
    }
  }

  private renderWarnings(container: HTMLElement, snapshot: WorkEventSnapshot): void {
    if (snapshot.warnings.length === 0) return;
    const details = container.createEl("details", { cls: "git-work-event-warnings" });
    const summary = details.createEl("summary");
    setIcon(summary.createSpan(), snapshot.confidence === "heuristic" ? "sparkles" : "info");
    summary.createSpan({
      text: snapshot.confidence === "heuristic"
        ? tr("这组提交是推测的编辑会话", "These commits are an inferred editing session")
        : tr(`${snapshot.warnings.length} 项读取说明`, `${snapshot.warnings.length} reading notes`)
    });
    const list = details.createEl("ul");
    for (const warning of snapshot.warnings) list.createEl("li", { text: warning });
  }

  private renderMaster(container: HTMLElement, snapshot: WorkEventSnapshot): void {
    const master = container.createDiv({ cls: "git-work-event-master" });
    const results = master.createDiv({ cls: "git-work-event-master-results" });
    if (shouldRenderWorkEventSearch(snapshot.netChanges.length, this.query)) {
      const search = master.createDiv({ cls: "git-work-event-search" });
      const inputShell = search.createDiv({ cls: "search-input-container" });
      setIcon(inputShell.createSpan({ cls: "git-work-event-search-icon" }), "search");
      const input = inputShell.createEl("input", {
        type: "search",
        value: this.query,
        placeholder: tr("筛选这次工作中的文件", "Filter files in this work"),
        attr: { "aria-label": tr("筛选这次工作中的文件", "Filter files in this work") }
      });
      let composing = false;
      const applyFilter = (): void => {
        if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
        this.filterTimer = window.setTimeout(() => {
          this.filterTimer = null;
          this.query = input.value;
          this.visibleFileLimit = 200;
          this.masterScrollTop = 0;
          this.renderMasterResults(results, snapshot);
          master.scrollTop = 0;
        }, 120);
      };
      input.addEventListener("compositionstart", () => {
        composing = true;
        if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
      });
      input.addEventListener("compositionend", () => {
        composing = false;
        applyFilter();
      });
      input.addEventListener("input", () => {
        if (!composing) applyFilter();
      });
      master.prepend(search);
    }
    this.renderMasterResults(results, snapshot);
    window.requestAnimationFrame(() => {
      master.scrollTop = this.masterScrollTop;
    });
  }

  private filteredChanges(snapshot: WorkEventSnapshot): WorkEventFileChange[] {
    const normalizedQuery = this.query.trim().toLocaleLowerCase();
    return normalizedQuery
      ? snapshot.netChanges.filter((change) =>
          [
            change.vaultPath,
            change.originalVaultPath ?? "",
            statusLabel(change)
          ].join(" ").toLocaleLowerCase().includes(normalizedQuery)
        )
      : snapshot.netChanges;
  }

  private renderMasterResults(
    container: HTMLElement,
    snapshot: WorkEventSnapshot
  ): void {
    container.empty();
    const normalizedQuery = this.query.trim().toLocaleLowerCase();
    const visible = this.filteredChanges(snapshot);
    const groups = groupWorkEventFiles(visible);
    const orderedVisible = groups.flatMap((group) => group.files);
    const selectedIndex = orderedVisible.findIndex(
      (change) => this.changeKey(change) === this.selectedKey
    );
    if (orderedVisible.length > 0 && selectedIndex < 0) {
      this.selectedKey = this.changeKey(orderedVisible[0]!);
      this.rerenderDetail(snapshot);
    } else if (orderedVisible.length === 0 && this.selectedKey) {
      this.selectedKey = "";
      this.rerenderDetail(snapshot);
    } else if (selectedIndex >= this.visibleFileLimit) {
      this.visibleFileLimit = Math.ceil((selectedIndex + 1) / 200) * 200;
    }
    const list = container.createDiv({ cls: "git-work-event-groups" });
    let remaining = this.visibleFileLimit;
    for (const group of groups) {
      if (remaining <= 0) break;
      const visibleFiles = group.files.slice(0, remaining);
      remaining -= visibleFiles.length;
      const technical = group.key === "technical";
      const section = technical
        ? list.createEl("details", {
            cls: `git-work-event-group is-${group.key}`
          })
        : list.createDiv({ cls: `git-work-event-group is-${group.key}` });
      if (
        technical
        && (
          normalizedQuery
          || group.files.some((change) => this.changeKey(change) === this.selectedKey)
        )
      ) (section as HTMLDetailsElement).open = true;
      const title = technical
        ? section.createEl("summary", { cls: "git-work-event-group-title" })
        : section.createDiv({ cls: "git-work-event-group-title" });
      title.createSpan({ text: group.label });
      title.createSpan({ text: String(group.files.length) });
      for (const change of visibleFiles) this.renderFileButton(section, change);
    }
    if (groups.length === 0) {
      container.createDiv({ cls: "git-work-event-no-results", text: tr("没有匹配的文件。", "No matching files.") });
    }
    if (visible.length > this.visibleFileLimit) {
      const more = container.createEl("button", {
        cls: "git-work-event-load-more",
        text: tr(`再显示 ${Math.min(200, visible.length - this.visibleFileLimit)} 个文件`, `Show ${Math.min(200, visible.length - this.visibleFileLimit)} more files`)
      });
      more.addEventListener("click", () => {
        this.visibleFileLimit += 200;
        this.renderMasterResults(container, snapshot);
      });
    }
    if (snapshot.hiddenRepositoryFileCount > 0) {
      const hidden = container.createDiv({ cls: "git-work-event-hidden" });
      setIcon(hidden.createSpan(), "shield");
      hidden.createSpan({
        text: tr(`${snapshot.hiddenRepositoryFileCount} 个 Vault 外文件未展示`, `${snapshot.hiddenRepositoryFileCount} files outside the vault not shown`)
      });
    }
  }

  private renderFileButton(container: HTMLElement, change: WorkEventFileChange): void {
    const key = this.changeKey(change);
    const active = key === this.selectedKey;
    const button = container.createEl("button", {
      cls: `git-work-event-file is-${change.status.toLocaleLowerCase()} ${change.isAnchor ? "is-anchor" : ""}`,
      attr: {
        "aria-current": active ? "true" : "false",
        title: change.vaultPath
      }
    });
    const icon = button.createSpan({ cls: "git-work-event-file-icon" });
    setIcon(icon, statusIcon(change));
    const pathCopy = button.createSpan({ cls: "git-work-event-file-copy" });
    const compact = compactPath(change.vaultPath);
    pathCopy.createSpan({ cls: "git-work-event-file-name", text: compact.name });
    if (compact.folder) {
      pathCopy.createSpan({ cls: "git-work-event-file-folder", text: compact.folder });
    }
    const meta = button.createSpan({ cls: "git-work-event-file-meta" });
    meta.createSpan({ text: statusLabel(change) });
    if (!change.binary) {
      meta.createSpan({ cls: "is-added", text: `+${change.addedLines}` });
      meta.createSpan({ cls: "is-removed", text: `−${change.deletedLines}` });
    }
    button.addEventListener("click", () => {
      this.masterScrollTop = button.closest<HTMLElement>(".git-work-event-master")?.scrollTop ?? 0;
      this.selectedKey = key;
      if (this.narrow) {
        this.detailOpen = true;
        this.render();
        window.requestAnimationFrame(() => {
          this.contentEl.querySelector<HTMLButtonElement>(".git-work-event-back")?.focus();
        });
        return;
      }
      this.contentEl
        .querySelectorAll<HTMLButtonElement>(".git-work-event-file")
        .forEach((candidate) => candidate.setAttribute(
          "aria-current",
          String(candidate === button)
        ));
      if (this.snapshot) this.rerenderDetail(this.snapshot);
    });
  }

  private rerenderDetail(snapshot: WorkEventSnapshot): void {
    const layout = this.contentEl.querySelector<HTMLElement>(".git-work-event-layout");
    if (!layout) return;
    const existing = layout.querySelector<HTMLElement>(".git-work-event-detail");
    if (!existing) return;
    existing.remove();
    this.renderDetail(layout, snapshot);
  }

  private returnToMaster(): void {
    this.detailOpen = false;
    this.render();
    window.requestAnimationFrame(() => {
      const selected = this.contentEl.querySelector<HTMLButtonElement>(
        '.git-work-event-file[aria-current="true"]'
      );
      selected?.scrollIntoView({ block: "nearest" });
      selected?.focus({ preventScroll: true });
    });
  }

  private renderDetail(container: HTMLElement, snapshot: WorkEventSnapshot): void {
    const detail = container.createDiv({ cls: "git-work-event-detail" });
    if (this.narrow) {
      const back = detail.createEl("button", { cls: "git-work-event-back" });
      setIcon(back.createSpan(), "arrow-left");
      back.createSpan({ text: tr("返回文件列表", "Back to the file list") });
      back.addEventListener("click", () => {
        this.returnToMaster();
      });
    }
    const change = snapshot.netChanges.find(
      (candidate) => this.changeKey(candidate) === this.selectedKey
    );
    if (!change) {
      detail.createDiv({
        cls: "git-work-event-preview-empty",
        text: this.query ? tr("筛选结果中没有可显示的文件。", "No files to show in the filtered result.") : tr("请选择一个文件查看修改。", "Choose a file to see its changes.")
      });
      return;
    }
    const heading = detail.createDiv({ cls: "git-work-event-detail-header" });
    const identity = heading.createDiv({ cls: "git-work-event-detail-identity" });
    identity.createEl("h3", { text: compactPath(change.vaultPath).name });
    identity.createDiv({
      cls: "git-work-event-detail-path",
      text: change.vaultPath,
      attr: { title: change.vaultPath }
    });
    if (change.originalVaultPath && change.originalVaultPath !== change.vaultPath) {
      const route = identity.createDiv({ cls: "git-work-event-route" });
      route.createSpan({
        cls: "git-work-event-route-path",
        text: change.originalVaultPath,
        attr: { title: change.originalVaultPath }
      });
      setIcon(route.createSpan(), "arrow-right");
      route.createSpan({
        cls: "git-work-event-route-path",
        text: change.vaultPath,
        attr: { title: change.vaultPath }
      });
    }
    const badges = identity.createDiv({ cls: "git-work-event-detail-badges" });
    badges.createSpan({
      cls: `is-${change.status.toLocaleLowerCase()}`,
      text: statusLabel(change)
    });
    if (!change.binary) {
      badges.createSpan({ cls: "is-added", text: `+${change.addedLines}` });
      badges.createSpan({ cls: "is-removed", text: `−${change.deletedLines}` });
    }
    const actions = heading.createDiv({ cls: "git-work-event-detail-actions" });
    const currentFile = change.status === "D"
      ? null
      : this.app.vault.getFileByPath(change.vaultPath);
    if (currentFile && change.openable !== false) {
      const open = actions.createEl("button", { text: tr("打开文件", "Open file") });
      setIcon(open.createSpan(), "file-up");
      open.addEventListener("click", () => {
        void this.app.workspace.getLeaf("tab").openFile(currentFile);
      });
    }
    const copyPath = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": tr("复制完整文件路径", "Copy full file path") }
    });
    setIcon(copyPath, "copy");
    copyPath.addEventListener("click", () => void (async () => {
      await navigator.clipboard.writeText(change.vaultPath);
      new Notice(tr("已复制完整文件路径。", "Full file path copied."));
    })());
    const canCompare = Boolean(
      currentFile
      && change.kind === "markdown"
      && change.status !== "A"
      && change.status !== "D"
      && !change.netUnchanged
      && snapshot.baseHash
      && snapshot.headHash
      && (snapshot.source !== "working" || change.previewStatus === "ready")
    );
    const compareHelpId = `git-work-event-compare-help-${this.changeKey(change)
      .replace(/[^\w-]+/g, "-")}`;
    const compare = actions.createEl("button", {
      cls: canCompare ? "mod-cta" : "",
      text: tr("打开完整对比", "Open full compare"),
      attr: {
        ...(canCompare ? {} : { "aria-describedby": compareHelpId }),
        title: canCompare
          ? ""
          : tr("新增、删除、未跟踪、根提交或当前已不存在的文件仅提供内联只读预览", "Added, deleted, untracked, root-commit or no-longer-present files get an inline read-only preview only")
      }
    });
    setIcon(compare.createSpan(), "git-compare-arrows");
    compare.disabled = !canCompare;
    compare.addEventListener("click", () => {
      void this.plugin.openWorkEventFileComparison(snapshot, change);
    });
    if (!canCompare) {
      detail.createDiv({
        cls: "git-work-event-compare-help",
        text: tr("这类变化缺少可验证的两端版本，因此只提供只读预览。", "This kind of change has no two verifiable ends, so only a read-only preview is offered."),
        attr: { id: compareHelpId }
      });
    }

    this.renderPreview(detail, change);
    this.renderRelations(detail, snapshot, change);
    if (snapshot.commits.length > 1) this.renderCommitTrail(detail, snapshot, change);
  }

  private renderPreview(container: HTMLElement, change: WorkEventFileChange): void {
    const section = container.createDiv({ cls: "git-work-event-preview" });
    const title = section.createDiv({ cls: "git-work-event-section-title" });
    title.createSpan({ text: tr("修改内容", "Changes") });
    title.createSpan({ text: tr("仅显示变化 · 已忽略空行", "Changes only · blank lines ignored") });
    if (change.previewStatus === "not-text") {
      section.createDiv({
        cls: "git-work-event-preview-empty",
        text: change.binary
          ? tr("二进制或附件文件只显示状态与路径。", "Binary files and attachments show only their status and path.")
          : tr("这个文件类型暂不提供文本预览。", "No text preview for this file type yet.")
      });
      return;
    }
    if (change.previewStatus !== "ready") {
      section.createDiv({
        cls: "git-work-event-preview-empty",
        text: change.previewStatus === "too-large"
          ? tr("文件超出本页的安全预览范围，未载入正文。", "The file is larger than this page can safely preview, so its text was not loaded.")
          : tr("历史两端内容不完整，无法生成文本预览。", "One end of the history is incomplete, so no text preview can be made.")
      });
      return;
    }
    const cacheKey = this.changeKey(change);
    let groups = this.diffCache.get(cacheKey);
    if (!groups) {
      groups = compactChangeGroups(
        change.beforeContent ?? "",
        change.afterContent ?? ""
      );
      if (this.diffCache.size >= 20) {
        const oldestKey = this.diffCache.keys().next().value;
        if (oldestKey) this.diffCache.delete(oldestKey);
      }
      this.diffCache.set(cacheKey, groups);
    }
    if (groups.length === 0) {
      section.createDiv({
        cls: "git-work-event-preview-empty",
        text: change.netUnchanged
          ? tr("这个文件在会话中曾被修改，但结束时内容回到了会话起点。", "This file was edited during the session but ended where the session started.")
          : tr("忽略空行后没有可见的正文变化。", "No visible text changes once blank lines are ignored.")
      });
      return;
    }
    const cards = section.createDiv({ cls: "git-work-event-diff-groups" });
    for (const [index, group] of groups.slice(0, 3).entries()) {
      const card = cards.createDiv({ cls: "git-work-event-diff-group" });
      card.createDiv({
        cls: "git-work-event-diff-group-label",
        text: tr(`变化 ${index + 1}`, `Change ${index + 1}`)
      });
      this.renderDiffLines(card, group.removed, "removed", group.added);
      this.renderDiffLines(card, group.added, "added", group.removed);
    }
    if (groups.length > 3) {
      section.createDiv({
        cls: "git-work-event-diff-more",
        text: tr(`还有 ${groups.length - 3} 处变化；打开完整对比可查看全部。`, `${groups.length - 3} more changes; open the full compare to see them all.`)
      });
    }
  }

  private renderDiffLines(
    container: HTMLElement,
    lines: readonly string[],
    kind: "added" | "removed",
    pairedLines: readonly string[]
  ): void {
    const visible = lines.slice(0, 10);
    for (const [lineIndex, line] of visible.entries()) {
      const row = container.createDiv({ cls: `git-work-event-diff-line is-${kind}` });
      row.createSpan({ cls: "git-work-event-diff-mark", text: kind === "added" ? "+" : "−" });
      const code = row.createEl("code");
      const paired = pairedLines[lineIndex];
      if (paired !== undefined && line.length + paired.length <= 4000) {
        for (const part of kind === "removed"
          ? diffWordsWithSpace(line, paired)
          : diffWordsWithSpace(paired, line)) {
          if ((kind === "removed" && part.added) || (kind === "added" && part.removed)) {
            continue;
          }
          code.createSpan({
            cls: part.added || part.removed ? "git-work-event-word-change" : "",
            text: part.value || " "
          });
        }
      } else {
        code.setText(line || " ");
      }
    }
    if (lines.length > visible.length) {
      container.createDiv({
        cls: `git-work-event-diff-omitted is-${kind}`,
        text: tr(`… ${lines.length - visible.length} 行未展开`, `… ${lines.length - visible.length} more lines`)
      });
    }
  }

  private renderRelations(
    container: HTMLElement,
    snapshot: WorkEventSnapshot,
    change: WorkEventFileChange
  ): void {
    const relations = snapshot.relationDeltas.filter((relation) =>
      relation.sourceAfterPath === change.vaultPath
      || relation.sourceBeforePath === change.vaultPath
      || (
        change.originalVaultPath
        && relation.sourceBeforePath === change.originalVaultPath
      )
    );
    if (relations.length === 0) return;
    const section = container.createDiv({ cls: "git-work-event-relations" });
    const title = section.createDiv({ cls: "git-work-event-section-title" });
    title.createSpan({ text: tr("关系变化", "Relation changes") });
    title.createSpan({ text: tr(`${relations.length} 项`, `${relations.length} items`) });
    const list = section.createDiv({ cls: "git-work-event-relation-list" });
    for (const relation of relations.slice(0, 40)) {
      this.renderRelation(list, relation);
    }
    if (relations.length > 40) {
      list.createDiv({ text: tr(`另有 ${relations.length - 40} 项未展开。`, `${relations.length - 40} more not shown.`) });
    }
  }

  private renderRelation(container: HTMLElement, relation: WorkEventRelationDelta): void {
    const row = container.createDiv({
      cls: `git-work-event-relation is-${relation.change}`
    });
    const icon = row.createSpan();
    setIcon(
      icon,
      relation.kind === "tag"
        ? "tag"
        : relation.kind === "footnote"
          ? "superscript"
          : relation.kind === "attachment"
            ? "paperclip"
            : relation.kind === "embed"
              ? "panel-top"
              : "link"
    );
    row.createSpan({
      cls: "git-work-event-relation-change",
      text: relation.change === "added" ? tr("新增", "Added") : tr("移除", "Removed")
    });
    row.createSpan({ cls: "git-work-event-relation-target", text: relation.label });
    if (relation.eventLocal) row.createSpan({ cls: "git-work-event-relation-local", text: tr("本事件内", "Within this event") });
    if (
      !relation.currentResolvedVaultPath
      && relation.kind !== "tag"
      && relation.kind !== "footnote"
    ) {
      row.createSpan({ cls: "git-work-event-relation-unresolved", text: tr("当前未解析", "Not resolved now") });
    }
  }

  private renderCommitTrail(
    container: HTMLElement,
    snapshot: WorkEventSnapshot,
    change: WorkEventFileChange
  ): void {
    const relevant = snapshot.commitSlices.filter((slice) =>
      slice.changes.some((candidate) =>
        candidate.repositoryPath === change.repositoryPath
        || candidate.originalRepositoryPath === change.repositoryPath
        || candidate.repositoryPath === change.originalRepositoryPath
      )
    );
    if (relevant.length === 0) return;
    const details = container.createEl("details", { cls: "git-work-event-commits" });
    details.createEl("summary", {
      text: tr(`这篇文件出现在会话中的 ${relevant.length} 个提交`, `This file appears in ${relevant.length} commits of the session`)
    });
    for (const slice of relevant) {
      const row = details.createDiv({ cls: "git-work-event-commit" });
      row.createSpan({ text: slice.commit.shortHash });
      row.createSpan({ text: slice.commit.subject });
      row.createSpan({ text: formatEventTime(slice.commit.committedAt) });
    }
  }
}
