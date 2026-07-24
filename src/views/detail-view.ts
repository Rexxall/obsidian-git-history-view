import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type {
  DetailMode,
  DetailRequest,
  GitCommitVersion,
  VersionReference
} from "../models";
import { buildSemanticDiff, renderSemanticDiff } from "../diff/semantic-diff";
import {
  buildLinkImpact,
  type LinkImpact,
  type NoteRelation
} from "../analysis/link-impact";
import { renderSideBySideDiff, renderUnifiedDiff } from "../ui/diff-renderer";
import { buildChangeMap, type ChangeMapItem } from "../diff/change-map";
import { RestorePreviewModal } from "../ui/restore-preview-modal";
import { RestoreHistoryModal } from "../ui/restore-history-modal";
import { BlockAgeModal } from "../ui/block-age-modal";
import {
  adjacentDistinctVersionReference,
  adjacentVersionReference,
  buildVersionSequence,
  versionReferenceKey,
  versionReferencePosition,
  type VersionDirection
} from "../history/version-navigation";

export const GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE = "git-note-history-detail-view";

function versionLabel(reference: VersionReference): string {
  if (reference.kind === "working") return reference.label;
  return `${reference.commit.shortHash} · ${reference.commit.subject || "无提交说明"}`;
}

function versionTitle(reference: VersionReference): string {
  return reference.kind === "working"
    ? reference.label
    : reference.commit.subject || "无提交说明";
}

function versionMeta(reference: VersionReference): string {
  if (reference.kind === "working") return "尚未提交的最新内容";
  const date = new Date(reference.commit.authoredAt);
  const timestamp = Number.isNaN(date.getTime())
    ? reference.commit.authoredAt
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(date);
  const stats = [
    reference.commit.addedLines > 0 ? `+${reference.commit.addedLines}` : "",
    reference.commit.deletedLines > 0 ? `−${reference.commit.deletedLines}` : ""
  ].filter(Boolean).join(" ");
  return `${reference.commit.shortHash} · ${timestamp}${stats ? ` · ${stats}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class VersionPickerModal extends FuzzySuggestModal<VersionReference> {
  constructor(
    app: App,
    private readonly choices: VersionReference[],
    sideLabel: string,
    private readonly selectedKey: string,
    private readonly onChoose: (reference: VersionReference) => void
  ) {
    super(app);
    this.setPlaceholder(`搜索并选择${sideLabel}…`);
  }

  getItems(): VersionReference[] {
    return this.choices;
  }

  getItemText(reference: VersionReference): string {
    const selected = versionReferenceKey(reference) === this.selectedKey ? "✓ " : "";
    return `${selected}${versionTitle(reference)} · ${versionMeta(reference)}`;
  }

  onChooseItem(reference: VersionReference): void {
    this.onChoose(reference);
  }
}

export class GitHistoryDetailView extends ItemView {
  private request: DetailRequest | null = null;
  private file: TFile | null = null;
  private baseContent = "";
  private targetContent = "";
  private mode: DetailMode = "side-by-side";
  private loading = false;
  private error = "";
  private generation = 0;
  private focusMode = false;
  private focusLayoutState: { leftCollapsed: boolean; rightCollapsed: boolean } | null = null;
  private changeMap: ChangeMapItem[] = [];
  private changeMapExpanded = false;
  private currentChangeIndex = 0;
  private narrowLayout = false;
  private resizeObserver: ResizeObserver | null = null;
  private historyCommits: GitCommitVersion[] = [];
  private historyLoadedFor = "";
  private activeVersionSide: "base" | "target" = "target";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GitNoteHistoryPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? `${this.file.basename} · Git 对比` : "Git 版本对比";
  }

  getIcon(): string {
    return "git-compare-arrows";
  }

  async setRequest(request: DetailRequest): Promise<void> {
    if (this.request?.filePath !== request.filePath) {
      this.historyCommits = [];
      this.historyLoadedFor = "";
    }
    this.request = request;
    this.mode = request.initialMode ?? this.plugin.settings.defaultDetailMode;
    await this.loadComparison();
  }

  async refresh(): Promise<void> {
    if (this.request) await this.loadComparison();
  }

  async onOpen(): Promise<void> {
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (event) => this.handleKeyboard(event));
    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? this.contentEl.clientWidth;
      const narrow = width > 0 && width < 760;
      if (narrow === this.narrowLayout) return;
      this.narrowLayout = narrow;
      this.render();
    });
    this.resizeObserver.observe(this.contentEl);
    this.render();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.restoreFocusLayout();
  }

  private async loadComparison(): Promise<void> {
    const request = this.request;
    if (!request) return;
    const file = this.app.vault.getFileByPath(request.filePath);
    if (!file) {
      this.file = null;
      this.error = `找不到笔记：${request.filePath}`;
      this.render();
      return;
    }

    const generation = ++this.generation;
    this.file = file;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const historyPromise = this.historyLoadedFor === file.path
        ? Promise.resolve(null)
        : this.plugin.gitClient.loadFileHistory(file).catch(() => null);
      const [baseContent, targetContent, history] = await Promise.all([
        this.plugin.gitClient.getContentForReference(file, request.repositoryRoot, request.base),
        this.plugin.gitClient.getContentForReference(file, request.repositoryRoot, request.target),
        historyPromise
      ]);
      if (generation !== this.generation) return;
      if (history) {
        this.historyCommits = history.commits;
        this.historyLoadedFor = file.path;
      }
      this.baseContent = baseContent;
      this.targetContent = targetContent;
      this.changeMap = buildChangeMap(baseContent, targetContent);
      this.currentChangeIndex = Math.min(this.currentChangeIndex, Math.max(0, this.changeMap.length - 1));
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = errorMessage(error);
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
    container.addClass("git-note-history-detail-view");
    container.toggleClass("is-compact", this.plugin.settings.density === "compact");
    container.toggleClass("is-focus", this.focusMode);

    if (!this.request || !this.file) {
      container.createDiv({ cls: "git-note-history-empty", text: this.error || "请从 Git 时间线选择一个版本。" });
      return;
    }

    const header = container.createDiv({ cls: "git-note-history-detail-toolbar" });
    const top = header.createDiv({ cls: "git-note-history-detail-top" });
    const heading = top.createDiv({ cls: "git-note-history-detail-heading" });
    heading.createEl("h3", { text: this.file.basename });
    heading.createDiv({ cls: "git-note-history-file-path", text: this.file.path });
    const focus = top.createEl("button", {
      cls: this.focusMode ? "clickable-icon is-active" : "clickable-icon",
      attr: {
        "aria-label": this.focusMode ? "退出专注审阅（Esc）" : "进入专注审阅",
        "aria-pressed": String(this.focusMode)
      }
    });
    setIcon(focus, this.focusMode ? "minimize-2" : "maximize-2");
    focus.addEventListener("click", () => {
      this.setFocusMode(!this.focusMode);
    });

    this.renderVersionWorkbench(header);

    const controls = header.createDiv({ cls: "git-note-history-detail-controls" });
    const modes = controls.createDiv({ cls: "git-note-history-detail-mode-group" });
    this.addTaskButton(modes, ["side-by-side", "unified"], "side-by-side", "读变化", "file-diff");
    this.addModeButton(modes, "preview", "预览", "book-open");
    this.addTaskButton(modes, ["semantic", "impact"], "semantic", "看影响", "list-tree");
    const viewOptions = modes.createEl("button", { attr: { "aria-label": "视图选项" } });
    setIcon(viewOptions.createSpan(), "ellipsis");
    viewOptions.addEventListener("click", (event) => this.openViewOptions(event));
    if (!this.loading && this.changeMap.length > 0) this.renderChangeNavigator(controls);
    const actions = controls.createDiv({ cls: "git-note-history-detail-action-group" });

    const whitespace = actions.createEl("button", {
      cls: this.plugin.settings.ignoreWhitespace ? "is-active" : "",
      attr: {
        "aria-label": "忽略空格变化",
        "aria-pressed": String(this.plugin.settings.ignoreWhitespace)
      }
    });
    setIcon(whitespace.createSpan(), "space");
    whitespace.createSpan({ text: "忽略空格" });
    whitespace.addEventListener("click", async () => {
      this.plugin.settings.ignoreWhitespace = !this.plugin.settings.ignoreWhitespace;
      await this.plugin.savePluginData();
      this.render();
    });

    const moreActions = actions.createEl("button", {
      attr: { "aria-label": "更多操作" }
    });
    setIcon(moreActions.createSpan(), "ellipsis-vertical");
    moreActions.createSpan({ text: "更多" });
    moreActions.addEventListener("click", (event) => this.openActionOptions(event));

    if (this.request.base.kind === "commit") {
      const restore = actions.createEl("button", { cls: "mod-warning git-note-history-restore-primary" });
      setIcon(restore.createSpan(), "history");
      restore.createSpan({ text: "恢复…" });
      restore.addEventListener("click", () => void this.confirmFullRestore());
    }

    if (this.loading) {
      container.createDiv({ cls: "git-note-history-loading", text: "正在准备版本对比…" });
      return;
    }
    if (this.error) {
      container.createEl("pre", { cls: "git-note-history-error", text: this.error });
      return;
    }

    const effectiveMode: DetailMode = this.mode === "side-by-side" && this.narrowLayout ? "unified" : this.mode;
    if (this.mode === "side-by-side" && this.narrowLayout) {
      container.createDiv({
        cls: "git-note-history-responsive-note",
        text: "当前宽度较窄，已自动使用统一 Diff；放宽页面后会恢复并排视图。"
      });
    }
    const isTextDiff = effectiveMode === "unified" || effectiveMode === "side-by-side";
    const showChangeMap = isTextDiff
      && this.changeMapExpanded
      && this.changeMap.length > 1
      && !this.narrowLayout;
    const shell = isTextDiff
      ? container.createDiv({
          cls: `git-note-history-review-shell ${showChangeMap ? "has-change-map" : "is-map-hidden"}`
        })
      : container;
    if (showChangeMap) this.renderChangeMap(shell);
    const body = shell.createDiv({ cls: `git-note-history-review-body mode-${effectiveMode}` });
    if (effectiveMode === "unified") this.renderUnified(body);
    else if (effectiveMode === "side-by-side") {
      renderSideBySideDiff(body, this.baseContent, this.targetContent, this.plugin.settings.ignoreWhitespace);
    } else if (effectiveMode === "preview") this.renderPreview(body);
    else if (effectiveMode === "semantic") renderSemanticDiff(body, buildSemanticDiff(this.baseContent, this.targetContent));
    else this.renderLinkImpact(body, buildLinkImpact(this.baseContent, this.targetContent));
  }

  private renderVersionWorkbench(container: HTMLElement): void {
    if (!this.request) return;
    const workbench = container.createDiv({ cls: "git-note-history-version-workbench" });
    this.renderVersionCard(workbench, "base", "左侧版本", "基准");
    const bridge = workbench.createDiv({ cls: "git-note-history-version-bridge" });
    const direction = bridge.createSpan({ cls: "git-note-history-version-direction" });
    setIcon(direction, "arrow-right");
    const swap = bridge.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "交换左右版本（X）" }
    });
    swap.disabled = this.loading
      || versionReferenceKey(this.request.base) === versionReferenceKey(this.request.target);
    setIcon(swap, "arrow-left-right");
    swap.addEventListener("click", () => this.swapVersions());
    const previous = this.previousToTarget();
    const alreadyAdjacent = previous !== null
      && versionReferenceKey(previous) === versionReferenceKey(this.request.base);
    const adjacent = bridge.createEl("button", {
      cls: "git-note-history-adjacent-button",
      attr: { "aria-label": "自动选择右侧版本的前一个版本" },
      text: alreadyAdjacent ? "已相邻" : "相邻"
    });
    adjacent.disabled = this.loading || previous === null || alreadyAdjacent;
    adjacent.addEventListener("click", () => this.compareAdjacentVersions());
    this.renderVersionCard(workbench, "target", "右侧版本", "对比");
  }

  private renderVersionCard(
    container: HTMLElement,
    side: "base" | "target",
    label: string,
    role: string
  ): void {
    if (!this.request) return;
    const reference = this.request[side];
    const other = this.request[side === "base" ? "target" : "base"];
    const older = adjacentDistinctVersionReference(
      this.historyCommits,
      reference,
      -1,
      other
    );
    const newer = adjacentDistinctVersionReference(
      this.historyCommits,
      reference,
      1,
      other
    );
    const position = versionReferencePosition(this.historyCommits, reference, [other]);
    const card = container.createDiv({
      cls: `git-note-history-version-card is-${side} ${this.activeVersionSide === side ? "is-active" : ""}`
    });
    const cardTop = card.createDiv({ cls: "git-note-history-version-card-top" });
    const cardLabel = cardTop.createDiv({ cls: "git-note-history-version-card-label" });
    cardLabel.createSpan({ text: label });
    cardLabel.createSpan({ cls: "git-note-history-version-role", text: role });
    const cardActions = cardTop.createDiv({ cls: "git-note-history-version-card-actions" });
    if (reference.kind !== "working") {
      const working = cardActions.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": `${label}改为当前工作区` }
      });
      working.disabled = this.loading || other.kind === "working";
      setIcon(working, "file-pen-line");
      working.addEventListener("click", () => this.setVersionReference(side, {
        kind: "working",
        label: "当前工作区"
      }));
    }
    const copy = cardActions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": `复制${label}内容` }
    });
    copy.disabled = this.loading;
    setIcon(copy, "copy");
    copy.addEventListener("click", () => void this.copyVersionContent(side));

    const navigator = card.createDiv({ cls: "git-note-history-version-navigator" });
    const earlier = navigator.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": `${label}切换到更早版本` }
    });
    earlier.disabled = this.loading || older === null;
    setIcon(earlier, "chevron-left");
    earlier.addEventListener("click", () => this.moveVersion(side, -1));

    const chooser = navigator.createEl("button", {
      cls: "git-note-history-version-chooser",
      attr: {
        "aria-label": `选择${label}，当前为 ${versionTitle(reference)}`,
        "aria-pressed": String(this.activeVersionSide === side)
      }
    });
    chooser.disabled = this.loading;
    const chooserText = chooser.createSpan({ cls: "git-note-history-version-chooser-text" });
    chooserText.createSpan({ cls: "git-note-history-version-title", text: versionTitle(reference) });
    chooserText.createSpan({ cls: "git-note-history-version-meta", text: versionMeta(reference) });
    const chooserIcon = chooser.createSpan({ cls: "git-note-history-version-chooser-icon" });
    setIcon(chooserIcon, "chevrons-up-down");
    chooser.addEventListener("click", () => this.openVersionPicker(side));

    const newerButton = navigator.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": `${label}切换到更新版本` }
    });
    newerButton.disabled = this.loading || newer === null;
    setIcon(newerButton, "chevron-right");
    newerButton.addEventListener("click", () => this.moveVersion(side, 1));
    card.createDiv({
      cls: "git-note-history-version-position",
      text: `${position.current} / ${position.total}`
    });
  }

  private openVersionPicker(side: "base" | "target"): void {
    if (!this.request) return;
    this.activeVersionSide = side;
    const current = this.request[side];
    const occupiedKey = versionReferenceKey(
      this.request[side === "base" ? "target" : "base"]
    );
    const choices = buildVersionSequence(this.historyCommits, [
      this.request.base,
      this.request.target
    ]).filter((reference) => versionReferenceKey(reference) !== occupiedKey).reverse();
    new VersionPickerModal(
      this.app,
      choices,
      side === "base" ? "左侧版本" : "右侧版本",
      versionReferenceKey(current),
      (reference) => this.setVersionReference(side, reference)
    ).open();
    this.render();
  }

  private setVersionReference(side: "base" | "target", reference: VersionReference): void {
    if (!this.request || versionReferenceKey(this.request[side]) === versionReferenceKey(reference)) return;
    const other = this.request[side === "base" ? "target" : "base"];
    if (versionReferenceKey(other) === versionReferenceKey(reference)) {
      new Notice("左右两侧需要选择不同版本。");
      return;
    }
    this.activeVersionSide = side;
    this.request = { ...this.request, [side]: reference };
    this.currentChangeIndex = 0;
    void this.loadComparison();
  }

  private moveVersion(side: "base" | "target", direction: VersionDirection): void {
    if (!this.request) return;
    const other = this.request[side === "base" ? "target" : "base"];
    const reference = adjacentDistinctVersionReference(
      this.historyCommits,
      this.request[side],
      direction,
      other
    );
    if (reference) this.setVersionReference(side, reference);
  }

  private swapVersions(): void {
    if (!this.request || this.loading) return;
    this.request = {
      ...this.request,
      base: this.request.target,
      target: this.request.base
    };
    this.activeVersionSide = this.activeVersionSide === "base" ? "target" : "base";
    this.currentChangeIndex = 0;
    void this.loadComparison();
  }

  private previousToTarget(): VersionReference | null {
    if (!this.request) return null;
    return adjacentVersionReference(
      this.historyCommits,
      this.request.target,
      -1,
      [this.request.base]
    );
  }

  private compareAdjacentVersions(): void {
    if (!this.request) return;
    const previous = this.previousToTarget();
    if (!previous) return;
    this.request = { ...this.request, base: previous };
    this.activeVersionSide = "target";
    this.currentChangeIndex = 0;
    void this.loadComparison();
  }

  private async copyVersionContent(side: "base" | "target"): Promise<void> {
    await navigator.clipboard.writeText(side === "base" ? this.baseContent : this.targetContent);
    new Notice(`已复制${side === "base" ? "左侧" : "右侧"}版本内容。`);
  }

  private addTaskButton(
    container: HTMLElement,
    activeModes: DetailMode[],
    targetMode: DetailMode,
    label: string,
    icon: string
  ): void {
    const button = container.createEl("button", {
      cls: activeModes.includes(this.mode) ? "is-active" : "",
      attr: { "aria-pressed": String(activeModes.includes(this.mode)) }
    });
    setIcon(button.createSpan(), icon);
    button.createSpan({ text: label });
    button.addEventListener("click", () => {
      this.mode = targetMode;
      if (this.file) void this.plugin.rememberDetailMode(this.file, targetMode);
      this.render();
    });
  }

  private addModeButton(container: HTMLElement, mode: DetailMode, label: string, icon: string): void {
    const button = container.createEl("button", {
      cls: this.mode === mode ? "is-active" : "",
      attr: { "aria-pressed": String(this.mode === mode) }
    });
    setIcon(button.createSpan(), icon);
    button.createSpan({ text: label });
    button.addEventListener("click", () => {
      this.mode = mode;
      if (this.file) void this.plugin.rememberDetailMode(this.file, mode);
      this.render();
    });
  }

  private openViewOptions(event: MouseEvent): void {
    const menu = new Menu();
    for (const [mode, label, icon] of [
      ["side-by-side", "并排词级 Diff", "columns-2"],
      ["unified", "统一 Diff", "list-minus"],
      ["preview", "Markdown 双预览", "book-open"],
      ["semantic", "Markdown 语义影响", "list-tree"],
      ["impact", "链接关系影响", "git-fork"]
    ] as const) {
      menu.addItem((item) => item
        .setTitle(label)
        .setIcon(icon)
        .setChecked(this.mode === mode)
        .onClick(() => {
          this.mode = mode;
          if (this.file) void this.plugin.rememberDetailMode(this.file, mode);
          this.render();
        }));
    }
    menu.showAtMouseEvent(event);
  }

  private openActionOptions(event: MouseEvent): void {
    const menu = new Menu();
    if (this.request?.base.kind === "commit") {
      menu.addItem((item) => item
        .setTitle("复制基准版本内容")
        .setIcon("copy")
        .onClick(async () => {
          await navigator.clipboard.writeText(this.baseContent);
          new Notice("已复制基准版本内容。");
        }));
      menu.addItem((item) => item
        .setTitle("把基准版本另存为副本")
        .setIcon("file-plus-2")
        .onClick(() => void this.saveBaseAsCopy()));
    }
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle("打开内容年龄镜头")
      .setIcon("scan-eye")
      .onClick(() => {
        if (this.file) new BlockAgeModal(this.app, this.plugin, this.file).open();
      }));
    menu.addItem((item) => item
      .setTitle("查看恢复历史")
      .setIcon("history")
      .onClick(() => new RestoreHistoryModal(this.app, this.plugin).open()));
    menu.showAtMouseEvent(event);
  }

  private renderChangeNavigator(container: HTMLElement): void {
    const nav = container.createDiv({ cls: "git-note-history-change-nav" });
    if (this.changeMap.length > 1 && !this.narrowLayout) {
      const mapToggle = nav.createEl("button", {
        cls: this.changeMapExpanded ? "clickable-icon is-active" : "clickable-icon",
        attr: {
          "aria-label": this.changeMapExpanded ? "隐藏变化地图" : "显示变化地图",
          "aria-pressed": String(this.changeMapExpanded)
        }
      });
      setIcon(mapToggle, "map");
      mapToggle.addEventListener("click", () => {
        this.changeMapExpanded = !this.changeMapExpanded;
        this.render();
      });
    }
    const previous = nav.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "上一个变化（[）" }
    });
    setIcon(previous, "arrow-up");
    previous.addEventListener("click", () => this.moveChange(-1));
    nav.createSpan({
      cls: "git-note-history-change-nav-label",
      text: `变化 ${this.currentChangeIndex + 1} / ${this.changeMap.length}`,
      attr: { "aria-live": "polite" }
    });
    const next = nav.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "下一个变化（]）" }
    });
    setIcon(next, "arrow-down");
    next.addEventListener("click", () => this.moveChange(1));
  }

  private renderChangeMap(container: HTMLElement): void {
    const map = container.createEl("aside", {
      cls: "git-note-history-change-map",
      attr: { "aria-label": "Markdown 标题变化地图" }
    });
    const heading = map.createDiv({ cls: "git-note-history-change-map-title" });
    setIcon(heading.createSpan(), "map");
    heading.createSpan({ text: "变化地图" });
    if (this.changeMap.length === 0) {
      map.createDiv({ cls: "git-note-history-change-map-empty", text: "内容一致" });
      return;
    }
    for (const item of this.changeMap) {
      const button = map.createEl("button", {
        cls: `git-note-history-change-map-item is-${item.kind} ${item.id - 1 === this.currentChangeIndex ? "is-active" : ""}`,
        attr: {
          "aria-label": `${item.title}，新增 ${item.addedLines} 行，删除 ${item.deletedLines} 行`,
          "aria-current": item.id - 1 === this.currentChangeIndex ? "true" : "false"
        }
      });
      button.style.setProperty("--gnh-heading-indent", `${Math.max(0, item.level - 1) * 3}px`);
      button.createSpan({ cls: "git-note-history-change-map-symbol", text: item.kind === "added" ? "+" : item.kind === "removed" ? "−" : "↔" });
      button.createSpan({ cls: "git-note-history-change-map-label", text: item.title });
      button.createSpan({ cls: "git-note-history-change-map-stats", text: `+${item.addedLines} −${item.deletedLines}` });
      button.addEventListener("click", () => this.scrollToChange(item.id - 1));
    }
  }

  private moveChange(direction: -1 | 1): void {
    if (this.changeMap.length === 0) return;
    const next = (this.currentChangeIndex + direction + this.changeMap.length) % this.changeMap.length;
    this.scrollToChange(next);
  }

  private scrollToChange(index: number): void {
    if (this.changeMap.length === 0) return;
    this.currentChangeIndex = Math.max(0, Math.min(index, this.changeMap.length - 1));
    const oneBased = this.currentChangeIndex + 1;
    this.contentEl.querySelectorAll<HTMLElement>(".git-note-history-change-map-item").forEach((item, itemIndex) => {
      item.toggleClass("is-active", itemIndex === this.currentChangeIndex);
      item.setAttribute("aria-current", itemIndex === this.currentChangeIndex ? "true" : "false");
    });
    const label = this.contentEl.querySelector<HTMLElement>(".git-note-history-change-nav-label");
    label?.setText(`变化 ${oneBased} / ${this.changeMap.length}`);
    const anchor = this.contentEl.querySelector<HTMLElement>(`[data-change-index="${oneBased}"]`);
    if (!anchor) return;
    anchor.scrollIntoView({ behavior: "smooth", block: "center" });
    anchor.focus({ preventScroll: true });
  }

  private renderUnified(container: HTMLElement): void {
    const canRestoreHunk = this.request?.target.kind === "working" && this.file !== null;
    renderUnifiedDiff(container, this.baseContent, this.targetContent, {
      ignoreWhitespace: this.plugin.settings.ignoreWhitespace,
      ...(canRestoreHunk
        ? {
            onRestoreHunk: async (targetContent: string, hunkNumber: number) => {
              if (!this.file) return;
              await this.confirmHunkRestore(targetContent, hunkNumber);
            },
            onLocateLine: async (line: number) => this.locateCurrentLine(line)
          }
        : {})
    });
  }

  private renderPreview(container: HTMLElement): void {
    if (!this.file || !this.request) return;
    const preview = container.createDiv({ cls: "git-note-history-preview-pair" });
    const left = preview.createDiv({ cls: "git-note-history-preview-column markdown-preview-view" });
    left.createDiv({ cls: "git-note-history-preview-label", text: versionLabel(this.request.base) });
    const leftBody = left.createDiv();
    void MarkdownRenderer.render(this.app, this.baseContent, leftBody, this.file.path, this);

    const right = preview.createDiv({ cls: "git-note-history-preview-column markdown-preview-view" });
    right.createDiv({ cls: "git-note-history-preview-label", text: versionLabel(this.request.target) });
    const rightBody = right.createDiv();
    void MarkdownRenderer.render(this.app, this.targetContent, rightBody, this.file.path, this);
  }

  private renderLinkImpact(container: HTMLElement, impact: LinkImpact): void {
    if (!this.file) return;
    const all = [...impact.added, ...impact.removed, ...impact.unchanged];
    const resolved = new Map<string, TFile>();
    for (const relation of all) {
      if (relation.kind === "tag") continue;
      const destination = this.app.metadataCache.getFirstLinkpathDest(relation.target, this.file.path);
      if (destination) resolved.set(relation.key, destination);
    }
    const backlinkCounts = this.countBacklinks([...resolved.values()]);

    const summary = container.createDiv({ cls: "git-note-history-impact-summary" });
    const summaryTitle = summary.createDiv({ cls: "git-note-history-impact-heading" });
    setIcon(summaryTitle.createSpan(), "git-fork");
    summaryTitle.createSpan({ text: "知识关系影响" });
    const stats = summary.createDiv({ cls: "git-note-history-impact-stats" });
    stats.createDiv({ cls: "is-added", text: `+${impact.added.length} 新关系` });
    stats.createDiv({ cls: "is-removed", text: `−${impact.removed.length} 移除` });
    const unresolvedCount = all.filter((relation) => relation.kind !== "tag" && !resolved.has(relation.key)).length;
    stats.createDiv({ cls: unresolvedCount > 0 ? "is-warning" : "", text: `${unresolvedCount} 个未解析目标` });

    if (impact.added.length === 0 && impact.removed.length === 0) {
      const stable = summary.createDiv({ cls: "git-note-history-impact-stable" });
      setIcon(stable.createSpan(), "circle-check-big");
      const message = stable.createDiv();
      message.createEl("strong", { text: "知识关系没有变化" });
      message.createDiv({ text: `两个版本包含相同的 ${impact.unchanged.length} 个链接、嵌入或标签。` });
      const steadyGroups = container.createDiv({ cls: "git-note-history-impact-groups is-stable" });
      this.renderRelationGroup(steadyGroups, "当前关系", "unchanged", impact.unchanged, resolved, backlinkCounts);
      return;
    }

    this.renderRelationGraph(summary, impact);
    const groups = container.createDiv({ cls: "git-note-history-impact-groups" });
    this.renderRelationGroup(groups, "新增关系", "added", impact.added, resolved, backlinkCounts);
    this.renderRelationGroup(groups, "移除关系", "removed", impact.removed, resolved, backlinkCounts);
    this.renderRelationGroup(groups, "保持不变", "unchanged", impact.unchanged, resolved, backlinkCounts);
  }

  private renderRelationGraph(container: HTMLElement, impact: LinkImpact): void {
    const relations = [
      ...impact.added.map((relation) => ({ relation, state: "added" })),
      ...impact.removed.map((relation) => ({ relation, state: "removed" })),
      ...impact.unchanged.slice(0, 10).map((relation) => ({ relation, state: "unchanged" }))
    ].slice(0, 24);
    if (relations.length === 0) {
      container.createDiv({ cls: "git-note-history-empty", text: "两个版本的链接与标签关系相同。" });
      return;
    }
    const width = 760;
    const height = Math.max(300, Math.ceil(relations.length / 12) * 180 + 120);
    const centerX = width / 2;
    const centerY = height / 2;
    const svg = container.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "git-note-history-impact-graph");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "当前笔记与新增、移除和未变化关系的局部图谱");
    container.appendChild(svg);

    relations.forEach(({ relation, state }, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, relations.length) - Math.PI / 2;
      const radiusX = relations.length <= 8 ? 250 : 310;
      const radiusY = relations.length <= 8 ? 105 : Math.max(115, height / 2 - 60);
      const x = centerX + Math.cos(angle) * radiusX;
      const y = centerY + Math.sin(angle) * radiusY;
      const edge = container.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "line");
      edge.setAttribute("x1", String(centerX));
      edge.setAttribute("y1", String(centerY));
      edge.setAttribute("x2", String(x));
      edge.setAttribute("y2", String(y));
      edge.setAttribute("class", `git-note-history-impact-edge is-${state}`);
      svg.appendChild(edge);
      const node = container.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
      node.setAttribute("cx", String(x));
      node.setAttribute("cy", String(y));
      node.setAttribute("r", "7");
      node.setAttribute("class", `git-note-history-impact-node is-${state}`);
      svg.appendChild(node);
      const label = container.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(x));
      label.setAttribute("y", String(y + (y < centerY ? -12 : 20)));
      label.setAttribute("class", "git-note-history-impact-node-label");
      label.setAttribute("text-anchor", "middle");
      label.textContent = relation.label.length > 22 ? `${relation.label.slice(0, 21)}…` : relation.label;
      svg.appendChild(label);
    });

    const center = container.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
    center.setAttribute("x", String(centerX - 72));
    center.setAttribute("y", String(centerY - 23));
    center.setAttribute("width", "144");
    center.setAttribute("height", "46");
    center.setAttribute("rx", "14");
    center.setAttribute("class", "git-note-history-impact-center");
    svg.appendChild(center);
    const centerLabel = container.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "text");
    centerLabel.setAttribute("x", String(centerX));
    centerLabel.setAttribute("y", String(centerY + 5));
    centerLabel.setAttribute("text-anchor", "middle");
    centerLabel.setAttribute("class", "git-note-history-impact-center-label");
    centerLabel.textContent = this.file?.basename ?? "当前笔记";
    svg.appendChild(centerLabel);
  }

  private renderRelationGroup(
    container: HTMLElement,
    title: string,
    state: "added" | "removed" | "unchanged",
    relations: NoteRelation[],
    resolved: Map<string, TFile>,
    backlinkCounts: Map<string, number>
  ): void {
    const group = container.createDiv({ cls: `git-note-history-impact-group is-${state}` });
    const heading = group.createDiv({ cls: "git-note-history-impact-group-title" });
    heading.createSpan({ text: title });
    heading.createSpan({ cls: "git-note-history-impact-count", text: String(relations.length) });
    if (relations.length === 0) {
      group.createDiv({ cls: "git-note-history-impact-none", text: "无" });
      return;
    }
    for (const relation of relations) {
      const destination = resolved.get(relation.key);
      const row = group.createEl(destination ? "button" : "div", { cls: "git-note-history-impact-row" });
      const kind = row.createSpan({ cls: "git-note-history-impact-kind" });
      setIcon(kind, relation.kind === "tag" ? "tag" : relation.kind === "embed" ? "paperclip" : "link");
      row.createSpan({ cls: "git-note-history-impact-label", text: relation.label });
      row.createSpan({ cls: "git-note-history-impact-type", text: relation.kind });
      if (relation.kind !== "tag") {
        row.createSpan({
          cls: `git-note-history-impact-resolution ${destination ? "is-resolved" : "is-unresolved"}`,
          text: destination
            ? `${backlinkCounts.get(destination.path) ?? 0} 篇反链`
            : "目标未解析"
        });
      }
      if (destination) row.addEventListener("click", () => void this.app.workspace.getLeaf(true).openFile(destination));
    }
  }

  private countBacklinks(destinations: TFile[]): Map<string, number> {
    const wanted = new Set(destinations.map((file) => file.path));
    const sourcesByDestination = new Map<string, Set<string>>();
    for (const source of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(source);
      const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
      for (const link of links) {
        const destination = this.app.metadataCache.getFirstLinkpathDest(link.link, source.path);
        if (!destination || !wanted.has(destination.path)) continue;
        const sources = sourcesByDestination.get(destination.path) ?? new Set<string>();
        sources.add(source.path);
        sourcesByDestination.set(destination.path, sources);
      }
    }
    return new Map([...sourcesByDestination].map(([path, sources]) => [path, sources.size]));
  }

  private async confirmFullRestore(): Promise<void> {
    if (!this.file || this.request?.base.kind !== "commit") return;
    const file = this.file;
    const commit = this.request.base.commit;
    const currentContent = await this.app.vault.read(file);
    new RestorePreviewModal(this.app, {
      file,
      title: `安全恢复到 ${commit.shortHash}`,
      currentContent,
      targetContent: this.baseContent,
      label: `恢复整篇到 ${commit.shortHash}`,
      sourceLabel: versionLabel(this.request.base),
      scope: "file",
      confirmText: "确认恢复整篇",
      onSaveCopy: () => this.saveBaseAsCopy(),
      onConfirm: async () => {
        try {
          if (await this.plugin.restoreService.restore(file, this.baseContent, {
            label: `恢复整篇到 ${commit.shortHash}`,
            sourceLabel: versionLabel(this.request!.base),
            scope: "file",
            expectedCurrentContent: currentContent
          })) {
            await this.loadComparison();
            this.plugin.refreshOpenViews();
          }
        } catch (error) {
          new Notice(errorMessage(error), 8000);
        }
      }
    }).open();
  }

  private async saveBaseAsCopy(): Promise<void> {
    if (!this.file || this.request?.base.kind !== "commit") return;
    const parentPath = this.file.parent?.path;
    const folder = !parentPath || parentPath === "/" ? "" : `${parentPath}/`;
    const baseName = `${this.file.basename}.git-${this.request.base.commit.shortHash}`;
    let candidate = normalizePath(`${folder}${baseName}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}${baseName}-${suffix}.md`);
      suffix += 1;
    }
    const copy = await this.app.vault.create(candidate, this.baseContent);
    await this.app.workspace.getLeaf(true).openFile(copy);
    new Notice(`已创建历史副本：${candidate}`);
  }

  private async confirmHunkRestore(targetContent: string, hunkNumber: number): Promise<void> {
    if (!this.file || !this.request) return;
    const file = this.file;
    const currentContent = await this.app.vault.read(file);
    new RestorePreviewModal(this.app, {
      file,
      title: `安全恢复变更块 ${hunkNumber}`,
      currentContent,
      targetContent,
      label: `恢复变更块 ${hunkNumber}`,
      sourceLabel: versionLabel(this.request.base),
      scope: "hunk",
      confirmText: "确认恢复此块",
      onConfirm: async () => {
        try {
          if (await this.plugin.restoreService.restore(file, targetContent, {
            label: `恢复变更块 ${hunkNumber}`,
            sourceLabel: versionLabel(this.request!.base),
            scope: "hunk",
            expectedCurrentContent: currentContent
          })) {
            await this.loadComparison();
            this.plugin.refreshOpenViews();
            const targetLine = this.changeMap[hunkNumber - 1]?.newStart;
            if (targetLine) await this.locateCurrentLine(targetLine);
          }
        } catch (error) {
          new Notice(errorMessage(error), 8000);
        }
      }
    }).open();
  }

  private async locateCurrentLine(line: number): Promise<void> {
    if (!this.file) return;
    await this.plugin.openFileAtLine(this.file, Math.max(0, line - 1));
  }

  private handleKeyboard(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === "Escape" && this.focusMode) {
      event.preventDefault();
      this.setFocusMode(false);
      return;
    }
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.setFocusMode(!this.focusMode);
      return;
    }
    if (event.key === "]") {
      event.preventDefault();
      this.moveChange(1);
      return;
    }
    if (event.key === "[") {
      event.preventDefault();
      this.moveChange(-1);
      return;
    }
    if (event.key.toLowerCase() === "x") {
      event.preventDefault();
      this.swapVersions();
      return;
    }
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      this.moveVersion(this.activeVersionSide, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    const modeByKey: Record<string, DetailMode> = {
      "1": "side-by-side",
      "2": "unified",
      "3": "preview",
      "4": "semantic",
      "5": "impact"
    };
    const mode = modeByKey[event.key];
    if (mode) {
      event.preventDefault();
      this.mode = mode;
      this.render();
    }
  }

  private setFocusMode(enabled: boolean): void {
    if (enabled === this.focusMode) return;
    if (enabled) {
      const { leftSplit, rightSplit } = this.app.workspace;
      this.focusLayoutState = {
        leftCollapsed: leftSplit.collapsed,
        rightCollapsed: rightSplit.collapsed
      };
      if (!leftSplit.collapsed) leftSplit.collapse();
      if (!rightSplit.collapsed) rightSplit.collapse();
    } else {
      this.restoreFocusLayout();
    }
    this.focusMode = enabled;
    this.render();
    window.requestAnimationFrame(() => {
      this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
      this.contentEl.focus();
    });
  }

  private restoreFocusLayout(): void {
    if (!this.focusLayoutState) return;
    const { leftSplit, rightSplit } = this.app.workspace;
    if (!this.focusLayoutState.leftCollapsed && leftSplit.collapsed) leftSplit.expand();
    if (!this.focusLayoutState.rightCollapsed && rightSplit.collapsed) rightSplit.expand();
    this.focusLayoutState = null;
    this.focusMode = false;
  }
}
