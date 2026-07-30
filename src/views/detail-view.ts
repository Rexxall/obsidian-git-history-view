import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  setIcon
} from "obsidian";
import type { FuzzyMatch } from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type {
  DetailMode,
  DetailRequest,
  FileReviewState,
  GitCommitVersion,
  GitRepositoryContext,
  VersionMilestone,
  VersionReference
} from "../models";
import {
  buildSemanticDiff,
  renderSemanticDiff,
  renderSemanticOverview
} from "../diff/semantic-diff";
import {
  buildLinkImpact,
  isVaultTargetRelation,
  type LinkImpact,
  type NoteRelation
} from "../analysis/link-impact";
import {
  compactLongFrontmatterPair,
  renderSideBySideDiff,
  renderUnifiedDiff,
  type HunkRestoreTarget
} from "../ui/diff-renderer";
import { createRecoveryBasketItem } from "../recovery-basket/planner";
import { createPropertyRecoveryItem } from "../recovery-basket/property-patch";
import type { RecoveryBasketSource } from "../recovery-basket/types";
import { buildChangeMap, type ChangeMapItem } from "../diff/change-map";
import {
  buildRenderedDiff,
  stripFrontmatter,
  type RenderedDiffSection
} from "../diff/rendered-diff";
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
import { compactHistoryPath } from "../history/path-history";
import {
  historyWithStoredMilestones,
  milestoneKindIcon,
  milestoneKindLabel,
  milestonesForCommit,
  previousNamedMilestone
} from "../history/milestones";
import { VersionMilestoneModal } from "../ui/milestone-modal";
import { remapVaultPath } from "../persistence/plugin-data";

export const GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE = "git-note-history-detail-view";

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

function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest("input, textarea, button, a, select, [contenteditable='true']") !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basenameFromVaultPath(path: string): string {
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return name.replace(/\.md$/iu, "") || "Git 版本对比";
}

class VersionPickerModal extends FuzzySuggestModal<VersionReference> {
  constructor(
    app: App,
    private readonly choices: VersionReference[],
    sideLabel: string,
    private readonly selectedKey: string,
    private readonly displayTitle: (reference: VersionReference) => string,
    private readonly searchText: (reference: VersionReference) => string,
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
    return `${selected}${this.searchText(reference)} · ${versionMeta(reference)}`;
  }

  renderSuggestion(match: FuzzyMatch<VersionReference>, element: HTMLElement): void {
    const reference = match.item;
    const searchDetail = this.searchText(reference);
    const row = element.createDiv({
      cls: "git-note-history-version-picker-item"
    });
    row.createDiv({
      cls: "git-note-history-version-picker-title",
      text: `${versionReferenceKey(reference) === this.selectedKey ? "✓ " : ""}${this.displayTitle(reference)}`
    });
    row.createDiv({
      cls: "git-note-history-version-picker-meta",
      text: `${versionMeta(reference)} · ${searchDetail}`,
      attr: { title: searchDetail }
    });
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
  private lastTextDiffMode: Extract<DetailMode, "side-by-side" | "unified"> = "side-by-side";
  private lastImpactMode: Extract<DetailMode, "semantic" | "impact"> = "semantic";
  private ignoreFrontmatter = false;
  private ignoreBlankLines = true;
  private collapseLongProperties = true;
  private changesOnly = true;
  private syncPreviewScroll = true;
  private loading = false;
  private error = "";
  private generation = 0;
  private contentGeneration = -1;
  private focusMode = false;
  private focusLayoutState: { leftCollapsed: boolean; rightCollapsed: boolean } | null = null;
  private changeMap: ChangeMapItem[] = [];
  private changeMapExpanded = false;
  private currentChangeIndex = 0;
  private narrowLayout = false;
  private resizeObserver: ResizeObserver | null = null;
  private historyCommits: GitCommitVersion[] = [];
  private historyContext: GitRepositoryContext | null = null;
  private historyLoadedFor = "";
  private activeVersionSide: "base" | "target" = "target";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GitNoteHistoryPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE;
  }

  getDisplayText(): string {
    const path = this.file?.path ?? this.request?.filePath;
    return path ? `${basenameFromVaultPath(path)} · Git 对比` : "Git 版本对比";
  }

  getIcon(): string {
    return "git-compare-arrows";
  }

  async setRequest(request: DetailRequest): Promise<void> {
    if (this.request?.filePath !== request.filePath) {
      this.historyCommits = [];
      this.historyLoadedFor = "";
      this.historyContext = null;
    }
    this.request = request;
    this.changesOnly = true;
    this.activeVersionSide = "target";
    this.mode = request.initialMode ?? this.plugin.settings.defaultDetailMode;
    if (this.mode === "side-by-side" || this.mode === "unified") this.lastTextDiffMode = this.mode;
    if (this.mode === "semantic" || this.mode === "impact") this.lastImpactMode = this.mode;
    await this.loadComparison();
  }

  async refresh(): Promise<void> {
    if (this.request) await this.loadComparison();
  }

  async onOpen(): Promise<void> {
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (event) => this.handleKeyboard(event));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      const request = this.request;
      if (!request) return;
      let nextPath = request.filePath;
      if (file instanceof TFile) {
        if (this.file !== file && request.filePath !== oldPath) return;
        this.file = file;
        nextPath = file.path;
      } else if (file instanceof TFolder) {
        nextPath = remapVaultPath(
          request.filePath,
          oldPath,
          file.path,
          true
        );
        if (nextPath === request.filePath) return;
        const nextFile = this.app.vault.getFileByPath(nextPath);
        if (nextFile instanceof TFile) this.file = nextFile;
      } else {
        return;
      }
      this.request = { ...request, filePath: nextPath };
      this.historyLoadedFor = "";
      this.historyContext = null;
      void this.loadComparison();
    }));
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
    this.generation += 1;
    this.contentGeneration = -1;
    this.loading = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.restoreFocusLayout();
  }

  private async loadComparison(): Promise<void> {
    const request = this.request;
    if (!request) return;
    const generation = ++this.generation;
    this.contentGeneration = -1;
    this.baseContent = "";
    this.targetContent = "";
    this.changeMap = [];
    this.currentChangeIndex = 0;
    const file = this.app.vault.getFileByPath(request.filePath);
    const hasFrozenPair = request.readOnly === true
      && request.baseContentOverride !== undefined
      && request.targetContentOverride !== undefined;
    if (!file && !hasFrozenPair) {
      this.file = null;
      this.loading = false;
      this.error = `找不到笔记：${request.filePath}`;
      this.render();
      return;
    }

    this.file = file ?? null;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const historyPromise = !file
        || request.readOnly
        || this.historyLoadedFor === file.path
        ? Promise.resolve(null)
        : this.plugin.gitClient.loadFileHistory(file).catch(() => null);
      const [baseContent, targetContent, history] = await Promise.all([
        request.baseContentOverride !== undefined
          ? Promise.resolve(request.baseContentOverride)
          : file
            ? this.plugin.gitClient.getContentForReference(
                file,
                request.repositoryRoot,
                request.base
              )
            : Promise.reject(new Error("冻结对比缺少左侧内容。")),
        request.targetContentOverride !== undefined
          ? Promise.resolve(request.targetContentOverride)
          : file
            ? this.plugin.gitClient.getContentForReference(
                file,
                request.repositoryRoot,
                request.target
              )
            : Promise.reject(new Error("冻结对比缺少右侧内容。")),
        historyPromise
      ]);
      if (generation !== this.generation) return;
      if (history && file) {
        await this.plugin.hydrateVersionMilestones(
          history.context,
          history.commits
        );
        if (generation !== this.generation) return;
        this.historyCommits = history.commits;
        this.historyContext = history.context;
        this.historyLoadedFor = file.path;
      }
      this.baseContent = baseContent;
      this.targetContent = targetContent;
      this.changeMap = buildChangeMap(baseContent, targetContent);
      this.currentChangeIndex = Math.min(this.currentChangeIndex, Math.max(0, this.changeMap.length - 1));
      this.contentGeneration = generation;
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

    if (!this.request) {
      container.createDiv({ cls: "git-note-history-empty", text: this.error || "请从 Git 时间线选择一个版本。" });
      return;
    }

    const displayPath = this.file?.path ?? this.request.filePath;
    const header = container.createDiv({ cls: "git-note-history-detail-toolbar" });
    const top = header.createDiv({ cls: "git-note-history-detail-top" });
    const heading = top.createDiv({ cls: "git-note-history-detail-heading" });
    heading.createEl("h3", { text: basenameFromVaultPath(displayPath) });
    heading.createDiv({ cls: "git-note-history-file-path", text: displayPath });
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
    const viewControls = controls.createDiv({ cls: "git-note-history-detail-view-controls" });
    const modes = viewControls.createDiv({
      cls: "git-note-history-detail-mode-group",
      attr: { "aria-label": "查看方式" }
    });
    this.addTaskButton(modes, ["side-by-side", "unified"], this.lastTextDiffMode, "对比", "git-compare-arrows");
    this.addModeButton(modes, "rendered", "阅读", "book-open");
    this.addModeButton(modes, "preview", "双预览", "columns-2");
    this.addTaskButton(modes, ["semantic", "impact"], this.lastImpactMode, "影响", "list-tree");
    this.renderContextControls(viewControls);
    const isRawDiffMode = this.mode === "side-by-side" || this.mode === "unified";
    if (
      !this.loading
      && isRawDiffMode
      && !this.ignoreFrontmatter
      && !this.ignoreBlankLines
      && this.changeMap.length > 0
    ) {
      this.renderChangeNavigator(controls);
    }
    const actions = controls.createDiv({ cls: "git-note-history-detail-action-group" });

    if (this.canCollectToRecoveryBasket()) {
      const basketCount = this.plugin.getRecoveryBasketCount(this.file!.path);
      const basket = actions.createEl("button", {
        cls: basketCount > 0 ? "git-note-history-basket-entry has-items" : "git-note-history-basket-entry",
        attr: { "aria-label": "打开恢复篮子" }
      });
      setIcon(basket.createSpan(), "shopping-basket");
      basket.createSpan({ text: basketCount > 0 ? `恢复篮子 ${basketCount}` : "恢复篮子" });
      basket.addEventListener("click", () => void this.plugin.openRecoveryBasket(this.file!));
    }

    const moreActions = actions.createEl("button", {
      attr: { "aria-label": "更多操作" }
    });
    setIcon(moreActions.createSpan(), "ellipsis-vertical");
    moreActions.createSpan({ text: "更多" });
    moreActions.disabled = !this.hasCurrentContent() || !this.file;
    moreActions.addEventListener("click", (event) => this.openActionOptions(event));

    if (this.request.base.kind === "commit" && !this.request.readOnly) {
      const restore = actions.createEl("button", { cls: "mod-warning git-note-history-restore-primary" });
      setIcon(restore.createSpan(), "history");
      restore.createSpan({ text: "恢复…" });
      restore.disabled = !this.hasCurrentContent();
      restore.addEventListener("click", () => void this.confirmFullRestore());
    }
    if (this.request.readOnly) {
      const snapshotTitle = this.request.allowRecoveryCollection
        ? "内容固定为沙盒核对时的快照；只能把选中的修改加入恢复篮子"
        : "内容固定为发起对比时的快照，不提供恢复、另存或里程碑编辑";
      const badge = actions.createSpan({
        cls: "git-note-history-read-only-badge",
        attr: { title: snapshotTitle }
      });
      setIcon(badge.createSpan(), "lock-keyhole");
      badge.createSpan({
        text: this.request.allowRecoveryCollection
          ? "冻结沙盒实验 · 仅收集"
          : "冻结快照 · 只读"
      });
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
    const isTextDiff = effectiveMode === "unified" || effectiveMode === "side-by-side";
    const rawComparison = this.comparisonContents();
    const compactedComparison = isTextDiff
      && !this.ignoreFrontmatter
      && this.collapseLongProperties
      ? compactLongFrontmatterPair(rawComparison.base, rawComparison.target)
      : {
          before: rawComparison.base,
          after: rawComparison.target,
          collapsedProperties: [] as string[]
        };
    const comparison = {
      base: compactedComparison.before,
      target: compactedComparison.after
    };
    if (this.mode === "side-by-side" && this.narrowLayout) {
      container.createDiv({
        cls: "git-note-history-responsive-note",
        text: "当前宽度较窄，已自动使用统一 Diff；放宽页面后会恢复并排视图。"
      });
    }
    const showChangeMap = isTextDiff
      && this.changeMapExpanded
      && this.changeMap.length > 1
      && !this.ignoreBlankLines
      && !this.narrowLayout;
    const shell = isTextDiff
      ? container.createDiv({
          cls: `git-note-history-review-shell ${showChangeMap ? "has-change-map" : "is-map-hidden"}`
        })
      : container;
    if (showChangeMap) this.renderChangeMap(shell);
    const body = shell.createDiv({ cls: `git-note-history-review-body mode-${effectiveMode}` });
    const renderTarget = compactedComparison.collapsedProperties.length > 0
      ? body.createDiv({ cls: "git-note-history-raw-diff-content" })
      : body;
    if (compactedComparison.collapsedProperties.length > 0) {
      const notice = body.createDiv({ cls: "git-note-history-collapsed-properties" });
      setIcon(notice.createSpan(), "fold-horizontal");
      const names = compactedComparison.collapsedProperties;
      notice.createSpan({
        text: `已折叠 ${names.length} 个长属性：${names.slice(0, 3).join("、")}${names.length > 3 ? "…" : ""}`
      });
      notice.createSpan({ text: "可在“过滤”中展开" });
      body.prepend(notice);
    }
    if (effectiveMode === "unified") this.renderUnified(renderTarget, comparison.base, comparison.target);
    else if (effectiveMode === "side-by-side") {
      renderSideBySideDiff(renderTarget, comparison.base, comparison.target, {
        ignoreWhitespace: this.plugin.settings.ignoreWhitespace,
        ignoreBlankLines: this.ignoreBlankLines,
        changesOnly: this.changesOnly
      });
    } else if (effectiveMode === "rendered") this.renderRenderedDiff(body);
    else if (effectiveMode === "preview") this.renderPreview(body);
    else if (effectiveMode === "semantic") {
      renderSemanticDiff(
        body,
        buildSemanticDiff(this.baseContent, this.targetContent),
        this.canCollectToRecoveryBasket()
          ? {
              onAddPropertyToBasket: async (propertyName) => {
                if (!this.request || !this.file) return;
                await this.addPropertyToRecoveryBasket(propertyName, {
                  request: this.request,
                  file: this.file,
                  generation: this.contentGeneration
                });
              }
            }
          : {}
      );
    }
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
      || this.request.readOnly === true
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
    adjacent.disabled = this.loading
      || this.request.readOnly === true
      || previous === null
      || alreadyAdjacent;
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
    const isStoredSnapshot = reference.kind === "commit"
      && !this.historyCommits.some((commit) => commit.hash === reference.commit.hash);
    const older = isStoredSnapshot
      ? null
      : adjacentDistinctVersionReference(
          this.historyCommits,
          reference,
          -1,
          other
        );
    const newer = isStoredSnapshot
      ? null
      : adjacentDistinctVersionReference(
          this.historyCommits,
          reference,
          1,
          other
        );
    const position = versionReferencePosition(
      this.knownHistoryCommits(),
      reference,
      [other]
    );
    const card = container.createDiv({
      cls: `git-note-history-version-card is-${side} ${this.activeVersionSide === side ? "is-active" : ""}`
    });
    const cardTop = card.createDiv({ cls: "git-note-history-version-card-top" });
    const cardLabel = cardTop.createDiv({ cls: "git-note-history-version-card-label" });
    cardLabel.createSpan({ text: label });
    cardLabel.createSpan({ cls: "git-note-history-version-role", text: role });
    cardLabel.createSpan({
      cls: "git-note-history-version-position",
      text: `${position.current} / ${position.total}`
    });
    const cardActions = cardTop.createDiv({ cls: "git-note-history-version-card-actions" });
    const state = this.historyContext
      ? this.plugin.getFileReviewState(this.historyContext)
      : null;
    const milestones = reference.kind === "commit" && state
      ? milestonesForCommit(state, reference.commit.hash, {
          includeReviewCheckpoint: false
        })
      : [];
    if (reference.kind !== "working") {
      if (!this.request.readOnly) {
        const manageMilestones = cardActions.createEl("button", {
          cls: "clickable-icon",
          attr: {
            "aria-label": milestones.length > 0
              ? `管理${label}的 ${milestones.length} 个里程碑`
              : `为${label}添加里程碑`,
            title: this.historyContext
              ? ""
              : "未能读取这篇笔记的 Git 上下文，暂时无法保存里程碑"
          }
        });
        manageMilestones.disabled = !this.historyContext || !this.hasCurrentContent();
        setIcon(manageMilestones, milestones.length > 0 ? "bookmark-check" : "bookmark-plus");
        manageMilestones.addEventListener("click", (event) => {
          this.openMilestoneMenu(event, reference.commit, milestones);
        });
      }
      const working = cardActions.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": `${label}改为当前工作区` }
      });
      working.disabled = this.loading || this.request.readOnly === true || other.kind === "working";
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
    copy.disabled = !this.hasCurrentContent();
    setIcon(copy, "copy");
    copy.addEventListener("click", () => void this.copyVersionContent(side));

    const navigator = card.createDiv({ cls: "git-note-history-version-navigator" });
    const earlier = navigator.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": `${label}切换到更早版本`,
        title: isStoredSnapshot
          ? "这个里程碑位于当前历史列表外，无法验证相邻版本"
          : older === null
            ? "没有可用的更早版本"
            : ""
      }
    });
    earlier.disabled = this.loading || this.request.readOnly === true || older === null;
    setIcon(earlier, "chevron-left");
    earlier.addEventListener("click", () => this.moveVersion(side, -1));

    const chooser = navigator.createEl("button", {
      cls: "git-note-history-version-chooser",
      attr: {
        "aria-label": `选择${label}，当前为 ${this.versionDisplayTitle(reference)}`,
        "aria-pressed": String(this.activeVersionSide === side)
      }
    });
    chooser.disabled = this.loading || this.request.readOnly === true;
    const chooserText = chooser.createSpan({ cls: "git-note-history-version-chooser-text" });
    chooserText.createSpan({
      cls: "git-note-history-version-title",
      text: milestones[0]?.label ?? versionTitle(reference)
    });
    chooserText.createSpan({ cls: "git-note-history-version-meta", text: versionMeta(reference) });
    const chooserIcon = chooser.createSpan({ cls: "git-note-history-version-chooser-icon" });
    setIcon(chooserIcon, "chevrons-up-down");
    chooser.addEventListener("click", () => this.openVersionPicker(side));

    const newerButton = navigator.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": `${label}切换到更新版本`,
        title: isStoredSnapshot
          ? "这个里程碑位于当前历史列表外，无法验证相邻版本"
          : newer === null
            ? "没有可用的更新版本"
            : ""
      }
    });
    newerButton.disabled = this.loading || this.request.readOnly === true || newer === null;
    setIcon(newerButton, "chevron-right");
    newerButton.addEventListener("click", () => this.moveVersion(side, 1));

    if (milestones.length > 0) {
      const milestoneRow = card.createDiv({ cls: "git-note-history-version-milestones" });
      for (const milestone of milestones.slice(0, 2)) {
        const eventTime = new Date(milestone.occurredAt);
        const formattedEventTime = Number.isNaN(eventTime.getTime())
          ? milestone.occurredAt
          : new Intl.DateTimeFormat("zh-CN", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false
            }).format(eventTime);
        const badge = milestoneRow.createSpan({
          cls: `git-note-history-version-milestone is-${milestone.kind}`,
          attr: {
            title: [
              `事件时间 ${formattedEventTime}`,
              milestone.note ?? ""
            ].filter(Boolean).join(" · ")
          }
        });
        setIcon(badge.createSpan(), milestoneKindIcon(milestone.kind));
        badge.createSpan({ text: milestone.label });
      }
      if (milestones.length > 2) {
        milestoneRow.createSpan({
          cls: "git-note-history-version-milestone-overflow",
          text: `+${milestones.length - 2}`,
          attr: {
            title: milestones.slice(2).map((milestone) => milestone.label).join("、")
          }
        });
      }
    }

    const pairedReference = this.request[side === "base" ? "target" : "base"];
    if (
      reference.kind === "commit"
      && pairedReference.kind === "commit"
      && reference.commit.historicalPath !== pairedReference.commit.historicalPath
    ) {
      const path = card.createDiv({
        cls: "git-note-history-version-path",
        attr: { title: reference.commit.historicalPath }
      });
      setIcon(path.createSpan(), "folder");
      path.createSpan({ text: compactHistoryPath(reference.commit.historicalPath, 3) });
    }
  }

  private openVersionPicker(side: "base" | "target"): void {
    if (!this.request || !this.file) return;
    const request = this.request;
    const file = this.file;
    const generation = this.contentGeneration;
    this.activeVersionSide = side;
    const current = request[side];
    const occupiedKey = versionReferenceKey(
      request[side === "base" ? "target" : "base"]
    );
    const choices = buildVersionSequence(this.knownHistoryCommits(), [
      request.base,
      request.target
    ]).filter((reference) => versionReferenceKey(reference) !== occupiedKey).reverse();
    new VersionPickerModal(
      this.app,
      choices,
      side === "base" ? "左侧版本" : "右侧版本",
      versionReferenceKey(current),
      (reference) => this.versionDisplayTitle(reference),
      (reference) => this.versionSearchText(reference),
      (reference) => {
        if (!this.isContentContextCurrent(request, file, generation)) {
          new Notice("对比已经切换，请从当前页面重新选择版本。");
          return;
        }
        this.setVersionReference(side, reference);
      }
    ).open();
    this.render();
  }

  private versionDisplayTitle(reference: VersionReference): string {
    if (reference.kind === "working" || !this.historyContext) {
      return versionTitle(reference);
    }
    const state = this.plugin.getFileReviewState(this.historyContext);
    return milestonesForCommit(
      state,
      reference.commit.hash,
      { includeReviewCheckpoint: false }
    )[0]?.label ?? versionTitle(reference);
  }

  private versionSearchText(reference: VersionReference): string {
    if (reference.kind === "working" || !this.historyContext) {
      return versionTitle(reference);
    }
    const state = this.plugin.getFileReviewState(this.historyContext);
    const milestones = milestonesForCommit(
      state,
      reference.commit.hash,
      { includeReviewCheckpoint: false }
    );
    return [
      versionTitle(reference),
      reference.commit.shortHash,
      reference.commit.historicalPath,
      this.historyCommits.some((commit) => commit.hash === reference.commit.hash)
        ? ""
        : "历史列表外",
      ...milestones.flatMap((milestone) => [
        milestone.label,
        milestoneKindLabel(milestone.kind),
        milestone.note ?? ""
      ])
    ].filter(Boolean).join(" · ");
  }

  private versionReceiptLabel(reference: VersionReference): string {
    return reference.kind === "working"
      ? reference.label
      : `${reference.commit.shortHash} · ${this.versionDisplayTitle(reference)}`;
  }

  private knownHistoryCommits(): GitCommitVersion[] {
    if (!this.historyContext) return this.historyCommits;
    return historyWithStoredMilestones(
      this.historyCommits,
      this.plugin.getFileReviewState(this.historyContext)
    );
  }

  private openMilestoneMenu(
    event: MouseEvent,
    commit: GitCommitVersion,
    milestones: VersionMilestone[]
  ): void {
    if (this.request?.readOnly || !this.hasCurrentContent()) return;
    const generation = this.contentGeneration;
    const menu = new Menu();
    for (const milestone of milestones) {
      menu.addItem((item) => item
        .setTitle(`编辑里程碑「${milestone.label}」`)
        .setIcon(milestoneKindIcon(milestone.kind))
        .onClick(() => this.openMilestoneEditor(commit, milestone, generation)));
    }
    menu.addItem((item) => item
      .setTitle(milestones.length > 0 ? "再添加一个里程碑" : "命名这个版本")
      .setIcon("bookmark-plus")
      .onClick(() => this.openMilestoneEditor(commit, undefined, generation)));
    menu.showAtMouseEvent(event);
  }

  private openMilestoneEditor(
    commit: GitCommitVersion,
    current?: VersionMilestone,
    expectedGeneration = this.contentGeneration
  ): void {
    if (!this.request || this.request.readOnly || !this.historyContext || !this.file) return;
    const request = this.request;
    const file = this.file;
    if (!this.isContentContextCurrent(request, file, expectedGeneration)) return;
    new VersionMilestoneModal(this.app, current, async (milestone) => {
      if (!this.isContentContextCurrent(request, file, expectedGeneration)) {
        new Notice("对比已经切换，请从当前页面重新编辑里程碑。");
        return;
      }
      const context = await this.plugin.gitClient.resolveFileContext(file);
      if (!this.isContentContextCurrent(request, file, expectedGeneration)) {
        new Notice("对比已经切换，未保存里程碑。");
        return;
      }
      await this.plugin.setVersionMilestone(
        context,
        commit,
        current?.id ?? null,
        milestone
      );
      this.plugin.refreshOpenViews();
      new Notice(milestone ? `已命名为「${milestone.label}」。` : "已移除里程碑。");
      if (this.file !== file) return;
      this.historyContext = context;
      this.historyLoadedFor = file.path;
      this.render();
    }).open();
  }

  private setVersionReference(side: "base" | "target", reference: VersionReference): void {
    if (this.request?.readOnly) return;
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
    const current = this.request[side];
    if (
      current.kind === "commit"
      && !this.historyCommits.some((commit) => commit.hash === current.commit.hash)
    ) return;
    const other = this.request[side === "base" ? "target" : "base"];
    const reference = adjacentDistinctVersionReference(
      this.historyCommits,
      current,
      direction,
      other
    );
    if (reference) this.setVersionReference(side, reference);
  }

  private swapVersions(): void {
    if (!this.request || this.loading || this.request.readOnly) return;
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
    const target = this.request.target;
    if (
      target.kind === "commit"
      && !this.historyCommits.some((commit) => commit.hash === target.commit.hash)
    ) return null;
    return adjacentVersionReference(
      this.historyCommits,
      target,
      -1,
      [this.request.base]
    );
  }

  private compareAdjacentVersions(): void {
    if (!this.request || this.request.readOnly) return;
    const previous = this.previousToTarget();
    if (!previous) return;
    this.request = { ...this.request, base: previous };
    this.activeVersionSide = "target";
    this.currentChangeIndex = 0;
    void this.loadComparison();
  }

  private async copyVersionContent(side: "base" | "target"): Promise<void> {
    if (!this.hasCurrentContent()) {
      new Notice("版本内容仍在加载，请稍后重试。");
      return;
    }
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
      this.setDetailMode(targetMode);
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
      this.setDetailMode(mode);
    });
  }

  private setDetailMode(mode: DetailMode): void {
    this.mode = mode;
    if (mode === "side-by-side" || mode === "unified") this.lastTextDiffMode = mode;
    if (mode === "semantic" || mode === "impact") this.lastImpactMode = mode;
    if (this.file) void this.plugin.rememberDetailMode(this.file, mode);
    this.render();
  }

  private renderContextControls(container: HTMLElement): void {
    const context = container.createDiv({
      cls: "git-note-history-detail-context-group",
      attr: { "aria-label": "当前视图选项" }
    });
    if (this.mode === "side-by-side" || this.mode === "unified") {
      this.addModeButton(context, "side-by-side", "双栏", "columns-2");
      this.addModeButton(context, "unified", "单栏", "rows-3");
      this.renderDiffFilterButton(context);
      return;
    }
    if (this.mode === "rendered") {
      this.renderDiffFilterButton(context);
      return;
    }
    if (this.mode === "preview") {
      this.addToggleButton(
        context,
        "同步滚动",
        "panel-top-open",
        this.syncPreviewScroll,
        () => {
          this.syncPreviewScroll = !this.syncPreviewScroll;
          this.render();
        }
      );
      return;
    }
    this.addModeButton(context, "semantic", "结构", "list-tree");
    this.addModeButton(context, "impact", "链接", "git-fork");
  }

  private renderDiffFilterButton(container: HTMLElement): void {
    const activeCount = [
      this.ignoreBlankLines,
      this.plugin.settings.ignoreWhitespace,
      this.ignoreFrontmatter,
      this.collapseLongProperties
    ].filter(Boolean).length;
    const button = container.createEl("button", {
      cls: activeCount > 0 ? "git-note-history-filter-button is-active" : "git-note-history-filter-button",
      attr: {
        "aria-label": `内容过滤，已启用 ${activeCount} 项`,
        "aria-haspopup": "menu"
      }
    });
    setIcon(button.createSpan(), "list-filter");
    button.createSpan({ text: "过滤" });
    button.createSpan({ cls: "git-note-history-filter-count", text: String(activeCount) });
    button.addEventListener("click", (event) => this.openDiffFilterOptions(event));
  }

  private openDiffFilterOptions(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle("忽略空行")
      .setIcon("list-minus")
      .setChecked(this.ignoreBlankLines)
      .onClick(() => {
        this.ignoreBlankLines = !this.ignoreBlankLines;
        this.render();
      }));
    menu.addItem((item) => item
      .setTitle("忽略空格变化")
      .setIcon("space")
      .setChecked(this.plugin.settings.ignoreWhitespace)
      .onClick(async () => {
        this.plugin.settings.ignoreWhitespace = !this.plugin.settings.ignoreWhitespace;
        await this.plugin.savePluginData();
        this.render();
      }));
    menu.addItem((item) => item
      .setTitle("忽略笔记属性")
      .setIcon("braces")
      .setChecked(this.ignoreFrontmatter)
      .onClick(() => {
        this.ignoreFrontmatter = !this.ignoreFrontmatter;
        this.render();
      }));
    menu.addItem((item) => item
      .setTitle("折叠长属性")
      .setIcon("fold-horizontal")
      .setChecked(this.collapseLongProperties)
      .onClick(() => {
        this.collapseLongProperties = !this.collapseLongProperties;
        this.render();
      }));
    menu.showAtMouseEvent(event);
  }

  private addToggleButton(
    container: HTMLElement,
    label: string,
    icon: string,
    active: boolean,
    onClick: () => void | Promise<void>
  ): void {
    const button = container.createEl("button", {
      cls: active ? "is-active" : "",
      attr: {
        "aria-label": label,
        "aria-pressed": String(active)
      }
    });
    setIcon(button.createSpan(), icon);
    button.createSpan({ text: label });
    button.addEventListener("click", () => void onClick());
  }

  private openActionOptions(event: MouseEvent): void {
    if (!this.hasCurrentContent() || !this.request || !this.file) return;
    const request = this.request;
    const file = this.file;
    const generation = this.generation;
    const baseContent = this.baseContent;
    const contextIsCurrent = (): boolean =>
      !this.loading
      && this.generation === generation
      && this.contentGeneration === generation
      && this.request === request
      && this.file === file;
    const rejectStaleAction = (): boolean => {
      if (contextIsCurrent()) return false;
      new Notice("版本对比已变化，请从当前页面重新打开操作菜单。");
      return true;
    };
    const menu = new Menu();
    if (this.mode === "side-by-side") {
      menu.addItem((item) => item
        .setTitle("显示未修改上下文")
        .setIcon("text-select")
        .setChecked(!this.changesOnly)
        .onClick(() => {
          if (rejectStaleAction()) return;
          this.changesOnly = !this.changesOnly;
          this.render();
        }));
      menu.addSeparator();
    }
    const reference = request[this.activeVersionSide];
    menu.addItem((item) => item
      .setTitle(
        reference.kind === "working"
          ? "查看当前未提交工作"
          : "查看此版本的工作事件"
      )
      .setIcon("git-pull-request-arrow")
      .onClick(() => {
        if (rejectStaleAction()) return;
        void this.plugin.openWorkEvent({
          repositoryRoot: request.repositoryRoot,
          anchorVaultPath: file.path,
          ...(reference.kind === "commit"
            ? {
                anchorHistoricalPath: reference.commit.historicalPath,
                source: {
                  kind: "commit" as const,
                  commitHash: reference.commit.hash,
                  aggregation: "commit" as const
                }
              }
            : { source: { kind: "working" as const } })
        });
      }));
    menu.addSeparator();
    if (!request.readOnly && this.historyContext) {
      const state = this.plugin.getFileReviewState(this.historyContext);
      const targetHash = request.target.kind === "commit"
        ? request.target.commit.hash
        : undefined;
      const titles = {
        sent: "与上次发送版比较",
        submitted: "与上次材料提交版比较",
        confirmed: "与上次确认版比较",
        exported: "与上次导出版比较",
        "important-draft": "与上个重要草稿比较",
        custom: ""
      } as const;
      for (const kind of [
        "sent",
        "submitted",
        "confirmed",
        "exported",
        "important-draft",
        "custom"
      ] as const) {
        const previous = previousNamedMilestone(
          this.historyCommits,
          state,
          targetHash,
          kind
        );
        if (
          !previous
          || versionReferenceKey(request.base) === previous.commit.hash
        ) continue;
        menu.addItem((item) => item
          .setTitle(titles[kind] || `与上个里程碑「${previous.milestone.label}」比较`)
          .setIcon(milestoneKindIcon(kind))
          .onClick(() => {
            if (rejectStaleAction()) return;
            this.setVersionReference("base", {
              kind: "commit",
              commit: previous.commit
            });
          }));
      }
    }
    if (request.base.kind === "commit") {
      menu.addItem((item) => item
        .setTitle("复制基准版本内容")
        .setIcon("copy")
        .onClick(async () => {
          if (rejectStaleAction()) return;
          await navigator.clipboard.writeText(baseContent);
          new Notice("已复制基准版本内容。");
        }));
      if (!request.readOnly) {
        menu.addItem((item) => item
          .setTitle("把基准版本另存为副本")
          .setIcon("file-plus-2")
          .onClick(() => {
            if (rejectStaleAction()) return;
            void this.saveBaseAsCopy();
          }));
      }
    }
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle("打开内容年龄镜头")
      .setIcon("scan-eye")
      .onClick(() => {
        if (rejectStaleAction()) return;
        new BlockAgeModal(this.app, this.plugin, file).open();
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

  private comparisonContents(): { base: string; target: string } {
    if (!this.ignoreFrontmatter) {
      return { base: this.baseContent, target: this.targetContent };
    }
    return {
      base: stripFrontmatter(this.baseContent),
      target: stripFrontmatter(this.targetContent)
    };
  }

  private renderUnified(container: HTMLElement, baseContent: string, targetContent: string): void {
    const request = this.request;
    const file = this.file;
    const generation = this.contentGeneration;
    const canPrepareHunk = !this.ignoreFrontmatter
      && !this.ignoreBlankLines
      && baseContent === this.baseContent
      && targetContent === this.targetContent
      && request?.target.kind === "working"
      && file !== null
      && this.hasCurrentContent();
    const canRestoreHunk = canPrepareHunk && !request?.readOnly;
    const canCollectHunk = canPrepareHunk && this.canCollectToRecoveryBasket();
    renderUnifiedDiff(container, baseContent, targetContent, {
      ignoreWhitespace: this.plugin.settings.ignoreWhitespace,
      ignoreBlankLines: this.ignoreBlankLines,
      ...(canRestoreHunk || canCollectHunk
        ? {
            ...(canRestoreHunk
              ? {
                  onRestoreHunk: async (
                    targetContent: string,
                    hunkNumber: number
                  ) => {
                    if (!request || !file) return;
                    await this.confirmHunkRestore(targetContent, hunkNumber, {
                      request,
                      file,
                      generation
                    });
                  }
                }
              : {}),
            ...(canCollectHunk
              ? {
                  onAddHunkToBasket: async (target: HunkRestoreTarget) => {
                    if (!request || !file) return;
                    await this.addHunkToRecoveryBasket(target, {
                      request,
                      file,
                      generation
                    });
                  }
                }
              : {}),
            onLocateLine: async (line: number) => this.locateCurrentLine(line)
          }
        : {})
    });
  }

  private renderRenderedDiff(container: HTMLElement): void {
    if (!this.request) return;
    const reader = container.createDiv({ cls: "git-note-history-reader" });
    const intro = reader.createDiv({ cls: "git-note-history-reader-intro" });
    const legend = intro.createDiv({ cls: "git-note-history-reader-legend" });
    legend.createSpan({ cls: "is-added", text: "新增" });
    legend.createSpan({ cls: "is-removed", text: "删除" });
    intro.createSpan({
      cls: "git-note-history-reader-hint",
      text: "按排版后的内容阅读改动；展开结构变化可检查属性、移动、任务和特殊区块。"
    });

    const semanticChanges = buildSemanticDiff(this.baseContent, this.targetContent, {
      ignoreFrontmatter: this.ignoreFrontmatter
    });
    renderSemanticOverview(reader, semanticChanges, true);

    const sections = buildRenderedDiff(this.baseContent, this.targetContent, {
      ignoreWhitespace: this.plugin.settings.ignoreWhitespace,
      ignoreFrontmatter: this.ignoreFrontmatter
    });
    if (sections.every((section) => section.kind === "unchanged")) {
      const empty = reader.createDiv({ cls: "git-note-history-reader-empty" });
      setIcon(empty.createSpan(), "circle-check-big");
      empty.createSpan({ text: "两个版本的可读内容一致" });
      return;
    }

    const document = reader.createDiv({
      cls: "git-note-history-reader-document markdown-preview-view"
    });
    for (const section of sections) this.renderRenderedSection(document, section);
  }

  private renderRenderedSection(container: HTMLElement, section: RenderedDiffSection): void {
    if (section.kind === "unchanged") {
      this.renderMarkdownBlocks(
        container.createDiv({ cls: "git-note-history-reader-unchanged" }),
        section.after
      );
      return;
    }
    const change = container.createEl("section", {
      cls: `git-note-history-reader-change is-${section.kind}`
    });
    if (section.kind === "changed" || section.kind === "removed") {
      const before = change.createDiv({ cls: "git-note-history-reader-version is-before" });
      before.createDiv({
        cls: "git-note-history-reader-change-label",
        text: section.kind === "changed" ? "修改前" : "已删除"
      });
      this.renderMarkdownBlocks(before, section.before);
    }
    if (section.kind === "changed" || section.kind === "added") {
      const after = change.createDiv({ cls: "git-note-history-reader-version is-after" });
      after.createDiv({
        cls: "git-note-history-reader-change-label",
        text: section.kind === "changed" ? "修改后" : "新增"
      });
      this.renderMarkdownBlocks(after, section.after);
    }
  }

  private renderMarkdownBlocks(container: HTMLElement, blocks: RenderedDiffSection["after"]): void {
    if (!this.request || blocks.length === 0) return;
    const content = blocks.map((block) => block.content).join("\n\n");
    const body = container.createDiv({ cls: "git-note-history-rendered-markdown" });
    void MarkdownRenderer.render(
      this.app,
      content,
      body,
      this.file?.path ?? this.request.filePath,
      this
    );
  }

  private renderPreview(container: HTMLElement): void {
    if (!this.request) return;
    const preview = container.createDiv({ cls: "git-note-history-preview-pair" });
    const leftBody = this.renderPreviewPane(
      preview,
      "base",
      "基准版本",
      this.request.base,
      this.baseContent
    );
    const rightBody = this.renderPreviewPane(
      preview,
      "target",
      "对比版本",
      this.request.target,
      this.targetContent
    );
    let syncing = false;
    const synchronize = (source: HTMLElement, target: HTMLElement): void => {
      if (!this.syncPreviewScroll || syncing) return;
      const sourceRange = source.scrollHeight - source.clientHeight;
      const targetRange = target.scrollHeight - target.clientHeight;
      if (sourceRange <= 0 || targetRange <= 0) return;
      syncing = true;
      target.scrollTop = (source.scrollTop / sourceRange) * targetRange;
      window.requestAnimationFrame(() => {
        syncing = false;
      });
    };
    leftBody.addEventListener("scroll", () => synchronize(leftBody, rightBody));
    rightBody.addEventListener("scroll", () => synchronize(rightBody, leftBody));
  }

  private renderPreviewPane(
    container: HTMLElement,
    side: "base" | "target",
    role: string,
    reference: VersionReference,
    content: string
  ): HTMLElement {
    const pane = container.createEl("section", {
      cls: `git-note-history-preview-pane is-${side}`
    });
    const header = pane.createDiv({ cls: "git-note-history-preview-header" });
    header.createSpan({ cls: "git-note-history-preview-role", text: role });
    const identity = header.createDiv({ cls: "git-note-history-preview-identity" });
    identity.createSpan({
      cls: "git-note-history-preview-title",
      text: this.versionDisplayTitle(reference)
    });
    identity.createSpan({ cls: "git-note-history-preview-meta", text: versionMeta(reference) });
    const body = pane.createDiv({
      cls: "git-note-history-preview-document markdown-preview-view"
    });
    void MarkdownRenderer.render(
      this.app,
      content,
      body,
      this.file?.path ?? this.request?.filePath ?? "",
      this
    );
    return body;
  }

  private renderLinkImpact(container: HTMLElement, impact: LinkImpact): void {
    if (!this.request) return;
    const sourcePath = this.file?.path ?? this.request.filePath;
    const all = [...impact.added, ...impact.removed, ...impact.unchanged];
    const resolved = new Map<string, TFile>();
    for (const relation of all) {
      if (!isVaultTargetRelation(relation)) continue;
      const destination = this.app.metadataCache.getFirstLinkpathDest(
        relation.target,
        sourcePath
      );
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
    const unresolvedCount = all.filter(
      (relation) => isVaultTargetRelation(relation) && !resolved.has(relation.key)
    ).length;
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
    centerLabel.textContent = basenameFromVaultPath(
      this.file?.path ?? this.request?.filePath ?? ""
    );
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
      setIcon(
        kind,
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
      row.createSpan({ cls: "git-note-history-impact-label", text: relation.label });
      row.createSpan({ cls: "git-note-history-impact-type", text: relation.kind });
      if (isVaultTargetRelation(relation)) {
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
    if (!this.file || !this.request || this.request.readOnly || !this.hasCurrentContent()) return;
    const base = this.request.base;
    if (base.kind !== "commit") return;
    const file = this.file;
    const request = this.request;
    const generation = this.contentGeneration;
    const commit = base.commit;
    const targetContent = this.baseContent;
    const sourceLabel = this.versionReceiptLabel(request.base);
    const currentContent = await this.app.vault.read(file);
    if (!this.isContentContextCurrent(request, file, generation)) {
      new Notice("对比已经切换，请重新发起恢复。");
      return;
    }
    new RestorePreviewModal(this.app, {
      file,
      title: `安全恢复到 ${commit.shortHash}`,
      currentContent,
      targetContent,
      label: `恢复整篇到 ${commit.shortHash}`,
      sourceLabel,
      scope: "file",
      confirmText: "确认恢复整篇",
      onSaveCopy: async () => {
        if (!this.isContentContextCurrent(request, file, generation)) {
          new Notice("对比已经切换，请重新发起另存。");
          return;
        }
        await this.saveBaseAsCopy({
          request,
          file,
          generation,
          content: targetContent
        });
      },
      onConfirm: async () => {
        if (!this.isContentContextCurrent(request, file, generation)) {
          new Notice("对比已经切换，请重新发起恢复。");
          return;
        }
        try {
          if (await this.plugin.restoreService.restore(file, targetContent, {
            label: `恢复整篇到 ${commit.shortHash}`,
            sourceLabel,
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

  private async saveBaseAsCopy(expected?: {
    request: DetailRequest;
    file: TFile;
    generation: number;
    content: string;
  }): Promise<void> {
    const request = expected?.request ?? this.request;
    const file = expected?.file ?? this.file;
    const generation = expected?.generation ?? this.contentGeneration;
    if (
      !file
      || !request
      || request.readOnly
      || request.base.kind !== "commit"
      || !this.isContentContextCurrent(request, file, generation)
    ) return;
    const content = expected?.content ?? this.baseContent;
    const parentPath = file.parent?.path;
    const folder = !parentPath || parentPath === "/" ? "" : `${parentPath}/`;
    const baseName = `${file.basename}.git-${request.base.commit.shortHash}`;
    let candidate = normalizePath(`${folder}${baseName}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}${baseName}-${suffix}.md`);
      suffix += 1;
    }
    if (!this.isContentContextCurrent(request, file, generation)) {
      new Notice("对比已经切换，请重新发起另存。");
      return;
    }
    const copy = await this.app.vault.create(candidate, content);
    await this.app.workspace.getLeaf(true).openFile(copy);
    new Notice(`已创建历史副本：${candidate}`);
  }

  private async confirmHunkRestore(
    targetContent: string,
    hunkNumber: number,
    expected?: {
      request: DetailRequest;
      file: TFile;
      generation: number;
    }
  ): Promise<void> {
    const file = expected?.file ?? this.file;
    const request = expected?.request ?? this.request;
    const generation = expected?.generation ?? this.contentGeneration;
    if (
      !file
      || !request
      || request.readOnly
      || !this.isContentContextCurrent(request, file, generation)
    ) return;
    const sourceLabel = this.versionReceiptLabel(request.base);
    const currentContent = await this.app.vault.read(file);
    if (!this.isContentContextCurrent(request, file, generation)) {
      new Notice("对比已经切换，请重新发起恢复。");
      return;
    }
    new RestorePreviewModal(this.app, {
      file,
      title: `安全恢复变更块 ${hunkNumber}`,
      currentContent,
      targetContent,
      label: `恢复变更块 ${hunkNumber}`,
      sourceLabel,
      scope: "hunk",
      confirmText: "确认恢复此块",
      onConfirm: async () => {
        if (!this.isContentContextCurrent(request, file, generation)) {
          new Notice("对比已经切换，请重新发起恢复。");
          return;
        }
        try {
          if (await this.plugin.restoreService.restore(file, targetContent, {
            label: `恢复变更块 ${hunkNumber}`,
            sourceLabel,
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

  private canCollectToRecoveryBasket(): boolean {
    return Boolean(
      this.request
      && (!this.request.readOnly || this.request.allowRecoveryCollection)
      && this.request.base.kind === "commit"
      && this.request.target.kind === "working"
      && this.file
      && this.hasCurrentContent()
    );
  }

  private recoveryBasketSource(request: DetailRequest): RecoveryBasketSource {
    if (request.recoverySourceOverride) {
      return { ...request.recoverySourceOverride };
    }
    if (request.base.kind !== "commit") {
      throw new Error("恢复篮子只能从 Git 历史版本收集内容。");
    }
    const commit = request.base.commit;
    return {
      versionKey: `commit:${commit.hash}:${commit.historicalPath}`,
      label: this.versionReceiptLabel(request.base),
      commitHash: commit.hash,
      shortHash: commit.shortHash,
      historicalPath: commit.historicalPath,
      authoredAt: commit.authoredAt,
      subject: commit.subject
    };
  }

  private async addHunkToRecoveryBasket(
    target: HunkRestoreTarget,
    expected: {
      request: DetailRequest;
      file: TFile;
      generation: number;
    }
  ): Promise<void> {
    const { request, file, generation } = expected;
    if (
      request.base.kind !== "commit"
      || !this.isContentContextCurrent(request, file, generation)
    ) return;
    const currentContent = await this.app.vault.read(file);
    if (
      !this.isContentContextCurrent(request, file, generation)
      || currentContent !== this.targetContent
    ) {
      new Notice("当前笔记已经变化，请刷新对比后再加入恢复篮子。");
      return;
    }
    const mapItem = this.changeMap[target.hunkNumber - 1];
    const item = createRecoveryBasketItem({
      filePath: file.path,
      kind: "hunk",
      label: mapItem?.title
        ? `${mapItem.title} · 变更块 ${target.hunkNumber}`
        : `变更块 ${target.hunkNumber}`,
      source: this.recoveryBasketSource(request),
      patches: [target.patch],
      previewBefore: target.currentBlock,
      previewAfter: target.historicalBlock
    });
    try {
      const basket = await this.plugin.addRecoveryBasketItem(file, currentContent, item);
      new Notice(`已加入恢复篮子（${basket.items.length} 项）`);
      this.render();
    } catch (error) {
      new Notice(errorMessage(error), 8000);
    }
  }

  private async addPropertyToRecoveryBasket(
    propertyName: string,
    expected: {
      request: DetailRequest;
      file: TFile;
      generation: number;
    }
  ): Promise<void> {
    const { request, file, generation } = expected;
    if (
      request.base.kind !== "commit"
      || !this.isContentContextCurrent(request, file, generation)
    ) return;
    const currentContent = await this.app.vault.read(file);
    if (
      !this.isContentContextCurrent(request, file, generation)
      || currentContent !== this.targetContent
    ) {
      new Notice("当前笔记已经变化，请刷新对比后再加入恢复篮子。");
      return;
    }
    try {
      const item = createPropertyRecoveryItem({
        filePath: file.path,
        propertyName,
        historicalContent: this.baseContent,
        currentContent,
        source: this.recoveryBasketSource(request)
      });
      const basket = await this.plugin.addRecoveryBasketItem(file, currentContent, item);
      new Notice(`已加入恢复篮子（${basket.items.length} 项）`);
      this.render();
    } catch (error) {
      new Notice(errorMessage(error), 8000);
    }
  }

  private hasCurrentContent(): boolean {
    return Boolean(
      this.request
      && !this.loading
      && this.contentGeneration === this.generation
    );
  }

  private isContentContextCurrent(
    request: DetailRequest,
    file: TFile,
    generation: number
  ): boolean {
    return this.hasCurrentContent()
      && this.request === request
      && this.file === file
      && this.generation === generation;
  }

  private async locateCurrentLine(line: number): Promise<void> {
    if (!this.file) return;
    await this.plugin.openFileAtLine(this.file, Math.max(0, line - 1));
  }

  private handleKeyboard(event: KeyboardEvent): void {
    if (
      event.defaultPrevented
      || event.metaKey
      || event.ctrlKey
      || isInteractiveKeyboardTarget(event.target)
    ) return;
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
      "1": this.lastTextDiffMode,
      "2": "rendered",
      "3": "preview",
      "4": this.lastImpactMode
    };
    const mode = modeByKey[event.key];
    if (mode) {
      event.preventDefault();
      this.setDetailMode(mode);
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
