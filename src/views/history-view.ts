import {
  ItemView,
  Menu,
  Notice,
  SearchComponent,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import { RestoreHistoryModal } from "../ui/restore-history-modal";
import type GitNoteHistoryPlugin from "../main";
import type {
  DetailMode,
  EffectiveVersionGroup,
  FileReviewState,
  GitCommitVersion,
  GitFileHistory,
  VersionMilestone,
  VersionReference
} from "../models";
import { GitCommandError } from "../git/git-client";
import { VersionMilestoneModal } from "../ui/milestone-modal";
import { ConfirmActionModal } from "../ui/confirm-modal";
import {
  contentFingerprint,
  groupEffectiveVersions,
  groupsSinceCheckpoint
} from "../history/version-groups";
import {
  DEFAULT_TIMELINE_BATCH_SIZE,
  buildTimelineWindow,
  expandTimelineLimit
} from "../history/timeline-window";
import {
  buildContentLifecycle,
  historicalContentMatch,
  type ContentLifecycle,
  type HistoricalContentMatch
} from "../history/content-search";
import {
  buildPathTransitions,
  compactHistoryPath,
  type PathTransition
} from "../history/path-history";
import {
  hasNamedMilestone,
  historyWithStoredMilestones,
  milestoneKindIcon,
  milestoneKindLabel,
  milestoneSearchText,
  milestonesForCommit,
  namedMilestoneEvents,
  previousNamedMilestone
} from "../history/milestones";
import {
  historyActivationMode,
  isHistoryRowActivationKey
} from "../history/version-navigation";
import { remapVaultPath } from "../persistence/plugin-data";

export const GIT_NOTE_HISTORY_VIEW_TYPE = "git-note-history-view";

function formatCommitTime(value: string, includeDate = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, includeDate
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" }).format(date);
}

function dateGroup(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更早";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startToday - startTarget) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return "本周";
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return "本月";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long" }).format(date);
}

function errorMessage(error: unknown): string {
  if (error instanceof GitCommandError) return error.stderr ? `${error.message}\n${error.stderr}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest("input, textarea, button, a, select, [contenteditable='true']") !== null;
}

function statusLabel(history: GitFileHistory): string {
  const { status } = history;
  if (status.conflicted) return "存在冲突";
  if (status.untracked) return "尚未跟踪";
  if (status.staged && status.unstaged) return "已暂存 + 未暂存";
  if (status.staged) return "已暂存";
  if (status.unstaged) return "未提交修改";
  return "工作区干净";
}

function matchesMetadata(commit: GitCommitVersion, query: string, state: FileReviewState): boolean {
  if (!query) return true;
  const milestone = milestoneSearchText(state, commit.hash);
  const trailers = Object.values(commit.trailers).join(" ");
  return [
    commit.subject,
    commit.authorName,
    commit.authorEmail,
    commit.hash,
    commit.authoredAt,
    commit.historicalPath,
    milestone,
    trailers
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase());
}

function matchesSearch(
  commit: GitCommitVersion,
  query: string,
  state: FileReviewState,
  contentMatches: ReadonlyMap<string, HistoricalContentMatch>
): boolean {
  return matchesMetadata(commit, query, state) || contentMatches.has(commit.hash);
}

export class GitNoteHistoryView extends ItemView {
  private targetFile: TFile | null = null;
  private history: GitFileHistory | null = null;
  private loading = false;
  private error = "";
  private query = "";
  private followActiveNote: boolean;
  private selectedIndex = 0;
  private readonly compareSelection = new Set<string>();
  private refreshGeneration = 0;
  private refreshTimer: number | null = null;
  private hoverTimer: number | null = null;
  private hoverHash = "";
  private readonly hoverPreviewCache = new Map<string, string>();
  private timeMachinePosition = -1;
  private timeMachineExpanded = false;
  private playbackTimer: number | null = null;
  private timeMachinePreviewTimer: number | null = null;
  private effectiveGroups: EffectiveVersionGroup[] = [];
  private readonly commitContents = new Map<string, string>();
  private readonly contentSearchMatches = new Map<string, HistoricalContentMatch>();
  private readonly contentSearchReadable = new Set<string>();
  private contentSearchTimer: number | null = null;
  private contentSearchGeneration = 0;
  private contentSearchLoading = false;
  private contentSearchScanned = 0;
  private contentSearchTotal = 0;
  private contentSearchFailed = 0;
  private readonly expandedGroups = new Set<string>();
  private showRawCommits = false;
  private showNamedMilestonesOnly = false;
  private pathHistoryExpanded = false;
  private pathTransitions: PathTransition[] = [];
  private currentContent = "";
  private currentFingerprint = "";
  private refiningGroups = false;
  private expandingMilestoneHistory = false;
  private milestoneExpansionGeneration = 0;
  private expandedMilestoneHistoryAttempted = false;
  private storedMilestonesExpanded = false;
  private visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GitNoteHistoryPlugin) {
    super(leaf);
    this.followActiveNote = plugin.settings.followActiveNote;
  }

  getViewType(): string {
    return GIT_NOTE_HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Git note history";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (event) => this.handleKeyboard(event), { capture: true });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      if (!this.followActiveNote) return;
      const active = this.app.workspace.getActiveFile();
      if (active?.extension === "md" && active.path !== this.targetFile?.path) void this.setFile(active);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.path === this.targetFile?.path) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && (oldPath === this.targetFile?.path || file.path === this.targetFile?.path)) {
        this.targetFile = file;
        void this.refresh();
        return;
      }
      if (file instanceof TFolder && this.targetFile) {
        const currentPath = this.targetFile.path;
        const nextPath = remapVaultPath(currentPath, oldPath, file.path, true);
        if (nextPath !== currentPath) {
          const nextFile = this.app.vault.getFileByPath(nextPath);
          if (nextFile instanceof TFile) this.targetFile = nextFile;
          void this.refresh();
        } else if (currentPath.startsWith(`${file.path}/`)) {
          // Obsidian may update descendant TFile objects before emitting only the folder event.
          void this.refresh();
        }
      }
    }));

    const active = this.app.workspace.getActiveFile();
    if (active?.extension === "md") await this.setFile(active);
    else this.render();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.cancelContentSearch();
    this.stopTimeMachinePlayback(false);
    if (this.timeMachinePreviewTimer !== null) window.clearTimeout(this.timeMachinePreviewTimer);
  }

  async setFile(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    this.stopTimeMachinePlayback(false);
    this.targetFile = file;
    this.history = null;
    this.query = "";
    this.cancelContentSearch();
    this.compareSelection.clear();
    this.commitContents.clear();
    this.effectiveGroups = [];
    this.pathTransitions = [];
    this.pathHistoryExpanded = false;
    this.showNamedMilestonesOnly = false;
    this.milestoneExpansionGeneration += 1;
    this.expandingMilestoneHistory = false;
    this.expandedMilestoneHistoryAttempted = false;
    this.storedMilestonesExpanded = false;
    this.expandedGroups.clear();
    this.selectedIndex = 0;
    this.timeMachinePosition = -1;
    this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const file = this.targetFile;
    if (!file) {
      this.render();
      return;
    }
    const generation = ++this.refreshGeneration;
    this.cancelContentSearch(false);
    this.refiningGroups = false;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const [history, currentContent] = await Promise.all([
        this.plugin.gitClient.loadFileHistory(file),
        this.app.vault.read(file)
      ]);
      if (generation !== this.refreshGeneration) return;
      await this.plugin.hydrateVersionMilestones(history.context, history.commits);
      if (generation !== this.refreshGeneration) return;
      this.history = history;
      this.currentContent = currentContent;
      this.currentFingerprint = contentFingerprint(currentContent);
      this.pathTransitions = buildPathTransitions(history.commits);
      const state = this.plugin.getFileReviewState(history.context);
      this.effectiveGroups = groupEffectiveVersions(history.commits, state, this.commitContents);
      this.timeMachinePosition = this.timeMachinePosition < 0
        ? this.timelineCommits().length
        : Math.min(this.timeMachinePosition, this.timelineCommits().length);
      void this.refineEffectiveGroups(generation);
    } catch (error) {
      if (generation !== this.refreshGeneration) return;
      this.history = null;
      this.error = errorMessage(error);
    } finally {
      if (generation === this.refreshGeneration) {
        this.loading = false;
        this.render();
        this.scheduleContentSearch();
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 800);
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "ap-view", "git-note-history-view");
    container.toggleClass("is-compact", this.plugin.settings.density === "compact");
    this.renderHeader(container);

    if (!this.targetFile) {
      this.renderState(container, "file-text", "打开一篇 Markdown 笔记", "版本历史会跟随当前笔记显示。");
      return;
    }
    if (this.loading) {
      this.renderSkeleton(container);
      return;
    }
    if (this.error) {
      this.renderState(container, "triangle-alert", "无法读取版本历史", "请检查 Git 仓库设置后重试。", "重新加载", () => void this.refresh(), this.error);
      return;
    }
    if (!this.history) return;

    const state = this.plugin.getFileReviewState(this.history.context);
    if (!this.query) {
      const overview = container.createDiv({ cls: "git-note-history-overview" });
      this.renderReviewInbox(overview, state);
      this.renderWorkingTreeCard(overview, state);
      if (!overview.hasChildNodes()) overview.remove();
      if (this.timeMachineExpanded) this.renderTimeMachine(container);
    }
    this.renderCompareBar(container);

    const storedMilestoneMatches = this.renderStoredMilestones(container, state);
    this.renderContentLifecycle(container);

    const commits = this.history.commits.filter((commit) =>
      matchesSearch(commit, this.query, state, this.contentSearchMatches)
      && (!this.showNamedMilestonesOnly || hasNamedMilestone(state, commit.hash))
    );
    if (commits.length === 0) {
      if (storedMilestoneMatches > 0) return;
      if (this.showNamedMilestonesOnly && !this.query) {
        this.renderState(
          container,
          "bookmark",
          "还没有命名里程碑",
          "在重要版本的更多菜单中选择“命名这个版本”。",
          "显示全部版本",
          () => {
            this.showNamedMilestonesOnly = false;
            this.render();
          }
        );
        return;
      }
      if (this.query) {
        if (this.contentSearchLoading) {
          this.renderState(
            container,
            "search",
            "正在搜索历史内容",
            `已检查 ${this.contentSearchScanned} / ${this.contentSearchTotal} 个版本。输入新内容即可取消当前搜索。`
          );
          return;
        }
        if (this.currentContentMatch()) {
          this.renderState(
            container,
            "file-pen-line",
            "只在当前工作区找到",
            `“${this.query}”尚未进入任何可读的 Git 版本。`
          );
          return;
        }
        this.renderState(
          container,
          "search-x",
          "没有匹配的版本",
          `没有找到“${this.query}”。`,
          "清除搜索",
          () => {
            this.query = "";
            this.selectedIndex = 0;
            this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
            this.render();
          }
        );
      } else {
        this.renderState(
          container,
          "git-commit-horizontal",
          "还没有 Git 版本",
          this.history.status.untracked ? "这篇笔记尚未被 Git 跟踪，首次提交后会出现在这里。" : "提交一次笔记后即可开始浏览版本。"
        );
      }
      return;
    }

    const timeline = container.createDiv({ cls: "git-note-history-timeline" });
    if (this.showRawCommits) {
      const window = buildTimelineWindow(commits, this.visibleTimelineCount);
      let previousGroup = "";
      window.items.forEach((commit, index) => {
        const group = dateGroup(commit.authoredAt);
        if (group !== previousGroup) {
          timeline.createDiv({ cls: "git-note-history-date-group", text: group });
          previousGroup = group;
        }
        this.renderCommitRow(timeline, commit, index, state);
      });
      this.renderTimelineFooter(timeline, window.visible, window.total);
      this.renderActionBar(container);
      return;
    }

    const groups = this.effectiveGroups.filter((group) =>
      group.commits.some((commit) =>
        matchesSearch(commit, this.query, state, this.contentSearchMatches)
        && (!this.showNamedMilestonesOnly || hasNamedMilestone(state, commit.hash))
      )
    );
    const window = buildTimelineWindow(groups, this.visibleTimelineCount);
    let previousGroup = "";
    window.items.forEach((group, index) => {
      const date = dateGroup(group.representative.authoredAt);
      if (date !== previousGroup) {
        timeline.createDiv({ cls: "git-note-history-date-group", text: date });
        previousGroup = date;
      }
      this.renderEffectiveGroupRow(timeline, group, index, groups, state);
    });
    this.renderTimelineFooter(timeline, window.visible, window.total);
    this.renderActionBar(container);
  }

  /** The glass bar under the list: both actions work on the selected version. */
  private renderActionBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "ap-action-bar git-note-history-action-bar" });
    const compare = bar.createEl("button", { text: "和当前比较" });
    compare.addEventListener("click", () => {
      const commit = this.selectedTimelineCommit();
      if (commit) void this.openAgainstWorking(commit);
    });
    const restore = bar.createEl("button", { cls: "mod-cta", text: "恢复这一版" });
    restore.addEventListener("click", () => {
      const commit = this.selectedTimelineCommit();
      if (commit) void this.restoreFromTimeline(commit);
    });
  }

  private filteredTimelineCommits(): GitCommitVersion[] {
    if (!this.history) return [];
    const state = this.plugin.getFileReviewState(this.history.context);
    const visible = (commit: GitCommitVersion): boolean =>
      matchesSearch(commit, this.query, state, this.contentSearchMatches)
      && (!this.showNamedMilestonesOnly || hasNamedMilestone(state, commit.hash));
    return this.showRawCommits
      ? this.history.commits.filter(visible)
      : this.effectiveGroups
          .filter((group) => group.commits.some(visible))
          .map((group) => group.representative);
  }

  private selectedTimelineCommit(): GitCommitVersion | undefined {
    const commits = this.filteredTimelineCommits();
    return commits[Math.min(this.selectedIndex, commits.length - 1)];
  }

  private async restoreFromTimeline(commit: GitCommitVersion): Promise<void> {
    if (!this.targetFile || !this.history) return;
    await this.plugin.openDetail({
      filePath: this.targetFile.path,
      repositoryRoot: this.history.context.repositoryRoot,
      base: { kind: "commit", commit },
      target: { kind: "working", label: "当前工作区" },
      initialMode: this.plugin.getFileReviewState(this.history.context).detailMode ?? this.plugin.settings.defaultDetailMode
    }, { restore: true });
  }

  private selectRow(row: HTMLElement, index: number): void {
    this.selectedIndex = index;
    row.parentElement
      ?.querySelectorAll(".git-note-history-commit.is-keyboard-selected")
      .forEach((candidate) => candidate.classList.remove("is-keyboard-selected"));
    row.classList.add("is-keyboard-selected");
  }

  private timelineCommits(): GitCommitVersion[] {
    const commits = this.showRawCommits
      ? (this.history?.commits ?? [])
      : this.effectiveGroups.map((group) => group.representative);
    if (!this.showNamedMilestonesOnly || !this.history) return commits;
    const state = this.plugin.getFileReviewState(this.history.context);
    return commits.filter((commit) => hasNamedMilestone(state, commit.hash));
  }

  private knownMilestoneCommits(state: FileReviewState): GitCommitVersion[] {
    return this.history
      ? historyWithStoredMilestones(this.history.commits, state)
      : [];
  }

  private async refineEffectiveGroups(generation: number): Promise<void> {
    if (!this.history) return;
    const history = this.history;
    const pending = history.commits.slice(0, 160).filter((commit) => !this.commitContents.has(commit.hash));
    if (pending.length === 0) return;
    this.refiningGroups = true;
    this.render();
    try {
      for (let index = 0; index < pending.length; index += 8) {
        const batch = pending.slice(index, index + 8);
        const contents = await Promise.all(batch.map(async (commit) => {
          try {
            return await this.plugin.gitClient.getFileContent(
              history.context.repositoryRoot,
              commit.hash,
              commit.historicalPath
            );
          } catch {
            return null;
          }
        }));
        if (generation !== this.refreshGeneration || this.history !== history) return;
        batch.forEach((commit, offset) => {
          const content = contents[offset];
          if (content !== null && content !== undefined) this.commitContents.set(commit.hash, content);
        });
      }
      if (generation !== this.refreshGeneration || this.history !== history) return;
      this.effectiveGroups = groupEffectiveVersions(
        history.commits,
        this.plugin.getFileReviewState(history.context),
        this.commitContents
      );
      this.timeMachinePosition = Math.min(this.timeMachinePosition, this.timelineCommits().length);
    } finally {
      if (generation === this.refreshGeneration) {
        this.refiningGroups = false;
        this.render();
      }
    }
  }

  private cancelContentSearch(clearResults = true): void {
    if (this.contentSearchTimer !== null) window.clearTimeout(this.contentSearchTimer);
    this.contentSearchTimer = null;
    this.contentSearchGeneration += 1;
    this.contentSearchLoading = false;
    this.contentSearchScanned = 0;
    this.contentSearchTotal = 0;
    this.contentSearchFailed = 0;
    if (clearResults) {
      this.contentSearchMatches.clear();
      this.contentSearchReadable.clear();
    }
  }

  private scheduleContentSearch(): void {
    if (this.contentSearchTimer !== null) window.clearTimeout(this.contentSearchTimer);
    this.contentSearchTimer = null;
    this.contentSearchGeneration += 1;
    const generation = this.contentSearchGeneration;
    this.contentSearchMatches.clear();
    this.contentSearchReadable.clear();
    this.contentSearchScanned = 0;
    this.contentSearchTotal = this.history?.commits.length ?? 0;
    this.contentSearchFailed = 0;
    this.contentSearchLoading = this.query.length >= 2 && this.contentSearchTotal > 0;
    if (!this.contentSearchLoading) return;
    const query = this.query;
    this.contentSearchTimer = window.setTimeout(() => {
      this.contentSearchTimer = null;
      void this.searchHistoricalContent(query, generation);
    }, 220);
  }

  private async searchHistoricalContent(query: string, generation: number): Promise<void> {
    const history = this.history;
    if (!history || query !== this.query || generation !== this.contentSearchGeneration) return;
    const batchSize = 8;
    for (let index = 0; index < history.commits.length; index += batchSize) {
      const batch = history.commits.slice(index, index + batchSize);
      const matchesBeforeBatch = this.contentSearchMatches.size;
      const results = await Promise.all(batch.map(async (commit) => {
        try {
          const cached = this.commitContents.get(commit.hash);
          const content = cached ?? await this.plugin.gitClient.getFileContent(
            history.context.repositoryRoot,
            commit.hash,
            commit.historicalPath
          );
          return { commit, content, match: historicalContentMatch(content, query), failed: false };
        } catch {
          return { commit, content: null, match: null, failed: true };
        }
      }));
      if (
        generation !== this.contentSearchGeneration
        || history !== this.history
        || query !== this.query
      ) return;
      for (const result of results) {
        if (!result.failed) this.contentSearchReadable.add(result.commit.hash);
        if (result.content !== null) this.commitContents.set(result.commit.hash, result.content);
        if (result.match) this.contentSearchMatches.set(result.commit.hash, result.match);
        if (result.failed) this.contentSearchFailed += 1;
      }
      this.contentSearchScanned = Math.min(history.commits.length, index + batch.length);
      if (
        (matchesBeforeBatch === 0 && this.contentSearchMatches.size > 0)
        || this.contentSearchScanned % 32 === 0
      ) this.render();
    }
    if (
      generation !== this.contentSearchGeneration
      || history !== this.history
      || query !== this.query
    ) return;
    this.contentSearchLoading = false;
    this.render();
  }

  private currentContentMatch(): HistoricalContentMatch | null {
    if (this.query.length < 2) return null;
    return historicalContentMatch(this.currentContent, this.query);
  }

  private contentLifecycle(): ContentLifecycle | null {
    if (!this.history || this.query.length < 2 || this.contentSearchLoading) return null;
    const versions = [...this.history.commits].reverse().map((commit) => ({
      key: commit.hash,
      state: this.contentSearchMatches.has(commit.hash)
        ? "present" as const
        : this.contentSearchReadable.has(commit.hash)
          ? "absent" as const
          : "unknown" as const
    }));
    versions.push({
      key: "working",
      state: this.currentContentMatch() ? "present" : "absent"
    });
    return buildContentLifecycle(versions);
  }

  private versionReferenceForKey(key: string): VersionReference | null {
    if (!this.history) return null;
    if (key === "working") return { kind: "working", label: "当前工作区" };
    const commit = this.history.commits.find((candidate) => candidate.hash === key);
    return commit ? { kind: "commit", commit } : null;
  }

  private lifecycleVersionLabel(key: string): string {
    if (key === "working") return "当前工作区";
    const commit = this.history?.commits.find((candidate) => candidate.hash === key);
    return commit ? `${formatCommitTime(commit.authoredAt, true)} · ${commit.shortHash}` : key.slice(0, 7);
  }

  private async openVersionPair(baseKey: string, targetKey: string): Promise<void> {
    if (!this.targetFile || !this.history) return;
    const base = this.versionReferenceForKey(baseKey);
    const target = this.versionReferenceForKey(targetKey);
    if (!base || !target) return;
    await this.plugin.openDetail({
      filePath: this.targetFile.path,
      repositoryRoot: this.history.context.repositoryRoot,
      base,
      target,
      initialMode: this.plugin.getFileReviewState(this.history.context).detailMode
        ?? this.plugin.settings.defaultDetailMode
    });
  }

  private renderContentLifecycle(container: HTMLElement): void {
    const lifecycle = this.contentLifecycle();
    if (!lifecycle || lifecycle.spans.length === 0) return;
    const firstSpan = lifecycle.spans[0]!;
    const lastSpan = lifecycle.spans.at(-1)!;
    const card = container.createDiv({ cls: "git-note-history-content-lifecycle" });
    const heading = card.createDiv({ cls: "git-note-history-content-lifecycle-heading" });
    const title = heading.createDiv({ cls: "git-note-history-content-lifecycle-title" });
    setIcon(title.createSpan(), "route");
    title.createSpan({ text: "内容轨迹" });
    heading.createSpan({
      cls: `git-note-history-content-lifecycle-state ${lifecycle.currentPresent ? "is-present" : "is-removed"}`,
      text: lifecycle.currentPresent ? "当前仍存在" : "当前已删除"
    });

    const milestones = card.createDiv({ cls: "git-note-history-content-lifecycle-milestones" });
    const addMilestone = (label: string, key: string, tone: string): void => {
      const item = milestones.createDiv({ cls: `git-note-history-content-lifecycle-milestone ${tone}` });
      item.createSpan({ cls: "git-note-history-content-lifecycle-dot" });
      const copy = item.createDiv();
      copy.createSpan({ cls: "git-note-history-content-lifecycle-label", text: label });
      copy.createSpan({ cls: "git-note-history-content-lifecycle-value", text: this.lifecycleVersionLabel(key) });
    };
    addMilestone("首次出现", lifecycle.firstAppearanceKey!, "is-introduced");
    if (lifecycle.lastPresenceKey !== lifecycle.firstAppearanceKey) {
      addMilestone(
        lifecycle.currentPresent ? "延续至" : "最后存在",
        lifecycle.lastPresenceKey!,
        "is-last"
      );
    }
    if (lastSpan.removedByKey) addMilestone("随后删除于", lastSpan.removedByKey, "is-removed");

    const notes: string[] = [];
    if (lifecycle.confirmedReappearances > 0) {
      notes.push(`曾重新出现 ${lifecycle.confirmedReappearances} 次`);
    }
    if (lifecycle.unknownVersions > 0) {
      notes.push(`${lifecycle.unknownVersions} 个版本无法验证`);
    }
    if (notes.length > 0) {
      card.createDiv({ cls: "git-note-history-content-lifecycle-note", text: notes.join(" · ") });
    }

    const actions = card.createDiv({ cls: "git-note-history-content-lifecycle-actions" });
    if (firstSpan.introducedAfterKey) {
      const introduced = actions.createEl("button", { text: "查看首次加入" });
      setIcon(introduced.createSpan(), "git-compare-arrows");
      introduced.addEventListener("click", () => {
        void this.openVersionPair(firstSpan.introducedAfterKey!, firstSpan.firstKey);
      });
    }
    if (lastSpan.removedByKey) {
      const removed = actions.createEl("button", { text: "查看删除位置" });
      setIcon(removed.createSpan(), "search-x");
      removed.addEventListener("click", () => {
        void this.openVersionPair(lastSpan.lastKey, lastSpan.removedByKey!);
      });
    }
  }

  /** Pending review shows as one entry row above the list; setting or clearing the point lives in the "…" menu. */
  private renderReviewInbox(container: HTMLElement, state: FileReviewState): void {
    if (!this.history || !this.targetFile) return;
    const latest = this.history.commits[0];
    const checkpoint = state.reviewCheckpoint;
    if (!latest || !checkpoint) return;

    const pendingGroups = groupsSinceCheckpoint(this.effectiveGroups, checkpoint.commitHash);
    const workingChanged = checkpoint.workingFingerprint
      ? checkpoint.workingFingerprint !== this.currentFingerprint
      : this.history.status.staged || this.history.status.unstaged || this.history.status.untracked;
    if (pendingGroups.length === 0 && !workingChanged) return;
    const pendingStats = pendingGroups.reduce(
      (total, group) => ({
        added: total.added + group.addedLines,
        deleted: total.deleted + group.deletedLines
      }),
      { added: this.history.workingTreeStats.addedLines, deleted: this.history.workingTreeStats.deletedLines }
    );
    const checkpointCommit = this.history.commits.find((commit) => commit.hash === checkpoint.commitHash)
      ?? {
        ...latest,
        hash: checkpoint.commitHash,
        shortHash: checkpoint.commitHash.slice(0, 7),
        historicalPath: checkpoint.historicalPath,
        subject: "上次复查点",
        authoredAt: checkpoint.reviewedAt,
        addedLines: 0,
        deletedLines: 0
      };

    const entry = container.createEl("button", {
      cls: "ap-disclosure-row git-note-history-review-inbox",
      attr: { type: "button", "aria-label": "审阅自上次复查以来的变化" }
    });
    setIcon(entry.createSpan({ cls: "ap-disclosure-icon" }), "inbox");
    const copy = entry.createSpan({ cls: "ap-disclosure-copy" });
    copy.createSpan({
      cls: "ap-disclosure-title",
      text: `待复查 ${pendingGroups.length} 个版本${workingChanged ? "＋当前工作区" : ""}`
    });
    copy.createSpan({
      cls: "ap-disclosure-sub",
      text: `自 ${formatCommitTime(checkpoint.reviewedAt, true)}`
    });
    const metrics = entry.createSpan({ cls: "git-note-history-review-inbox-metrics" });
    metrics.createSpan({ cls: "is-added", text: `+${pendingStats.added}` });
    metrics.createSpan({ cls: "is-removed", text: `−${pendingStats.deleted}` });
    setIcon(entry.createSpan({ cls: "ap-disclosure-chevron" }), "chevron-right");
    entry.addEventListener("click", () => void this.openAgainstWorking(checkpointCommit));
  }

  private addReviewMenuItems(menu: Menu): void {
    const history = this.history;
    const latest = history?.commits[0];
    if (!history || !latest) return;
    const checkpoint = this.plugin.getFileReviewState(history.context).reviewCheckpoint;
    if (!checkpoint) {
      menu.addItem(item => item
        .setTitle("设为复查起点")
        .setIcon("circle-dot-dashed")
        .onClick(() => void this.markCurrentReviewed(latest)));
      return;
    }
    menu.addItem(item => item
      .setTitle("标记已复查")
      .setIcon("check-check")
      .onClick(() => void this.markCurrentReviewed(latest)));
    menu.addItem(item => item
      .setTitle("清除复查点")
      .setIcon("x")
      .onClick(async () => {
        await this.plugin.clearReviewCheckpoint(history.context);
        this.render();
      }));
  }

  private async markCurrentReviewed(latest: GitCommitVersion): Promise<void> {
    if (!this.history) return;
    await this.plugin.markReviewed(this.history.context, latest, this.currentFingerprint);
    new Notice(`已复查到 ${latest.shortHash}。`);
    this.effectiveGroups = groupEffectiveVersions(
      this.history.commits,
      this.plugin.getFileReviewState(this.history.context),
      this.commitContents
    );
    this.render();
  }

  private renderStoredMilestones(
    container: HTMLElement,
    state: FileReviewState
  ): number {
    if (!this.history) return 0;
    const loadedHashes = new Set(this.history.commits.map((commit) => commit.hash));
    const stored = historyWithStoredMilestones(this.history.commits, state)
      .slice(this.history.commits.length)
      .filter((commit) => matchesMetadata(commit, this.query, state));
    const locatedHashes = new Set([
      ...loadedHashes,
      ...stored.map((commit) => commit.hash)
    ]);
    const unresolvedByHash = new Map<string, VersionMilestone[]>();
    for (const milestone of namedMilestoneEvents(state)) {
      if (locatedHashes.has(milestone.commitHash)) continue;
      const searchText = [
        milestone.label,
        milestoneKindLabel(milestone.kind),
        milestone.note ?? "",
        milestone.commitHash
      ].join(" ").toLocaleLowerCase();
      if (this.query && !searchText.includes(this.query.toLocaleLowerCase())) continue;
      const existing = unresolvedByHash.get(milestone.commitHash) ?? [];
      existing.push(milestone);
      unresolvedByHash.set(milestone.commitHash, existing);
    }
    const total = stored.length + unresolvedByHash.size;
    if (total === 0) return 0;
    const showAll = this.showNamedMilestonesOnly
      || Boolean(this.query)
      || this.storedMilestonesExpanded;
    const visibleStored = showAll ? stored : stored.slice(0, 3);
    const remainingSlots = showAll ? Number.POSITIVE_INFINITY : 3 - visibleStored.length;
    const visibleUnresolved = [...unresolvedByHash.entries()]
      .slice(0, Math.max(0, remainingSlots));

    const section = container.createDiv({
      cls: "git-note-history-stored-milestones"
    });
    const heading = section.createDiv({
      cls: "git-note-history-stored-milestones-heading"
    });
    const title = heading.createDiv();
    setIcon(title.createSpan(), "archive-restore");
    title.createSpan({ text: "当前历史列表外的里程碑" });
    heading.createSpan({
      text: `${total} 个版本`
    });
    if (total > 3 && !this.showNamedMilestonesOnly && !this.query) {
      const toggle = heading.createEl("button", {
        text: this.storedMilestonesExpanded ? "收起" : "显示全部"
      });
      toggle.addEventListener("click", () => {
        this.storedMilestonesExpanded = !this.storedMilestonesExpanded;
        this.render();
      });
    }

    for (const commit of visibleStored) {
      const milestones = milestonesForCommit(state, commit.hash, {
        includeReviewCheckpoint: false
      });
      const item = section.createDiv({
        cls: "git-note-history-stored-milestone"
      });
      const open = item.createEl("button", {
        cls: "git-note-history-stored-milestone-main",
        attr: {
          "aria-label": `将${milestones.map((milestone) => milestone.label).join("、")}与当前工作区比较`
        }
      });
      const copy = open.createSpan({
        cls: "git-note-history-stored-milestone-copy"
      });
      copy.createSpan({
        cls: "git-note-history-stored-milestone-title",
        text: milestones.slice(0, 2).map((milestone) => milestone.label).join(" · ")
      });
      copy.createSpan({
        cls: "git-note-history-stored-milestone-meta",
        text: `${formatCommitTime(commit.authoredAt, true)} · ${commit.shortHash}`
      });
      open.addEventListener("click", () => void this.openAgainstWorking(commit));

      const badges = item.createDiv({ cls: "git-note-history-badges" });
      this.renderMilestoneBadges(badges, milestones, commit);
      const more = item.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "更多里程碑操作" }
      });
      setIcon(more, "ellipsis");
      more.addEventListener("click", (event) => {
        this.openCommitMenu(event, commit, state);
      });
    }

    for (const [hash, milestones] of visibleUnresolved) {
      const item = section.createDiv({
        cls: "git-note-history-stored-milestone is-unresolved"
      });
      const copy = item.createDiv({
        cls: "git-note-history-stored-milestone-copy"
      });
      copy.createSpan({
        cls: "git-note-history-stored-milestone-title",
        text: milestones.slice(0, 2).map((milestone) => milestone.label).join(" · ")
      });
      copy.createSpan({
        cls: "git-note-history-stored-milestone-meta",
        text: `${hash.slice(0, 7)} · 旧标签尚未定位`
      });
      const more = item.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "管理无法定位的本地里程碑" }
      });
      setIcon(more, "ellipsis");
      more.addEventListener("click", (event) => {
        const menu = new Menu();
        const commit = this.commitReferenceForMilestone(milestones[0]!);
        this.addMilestoneMenuItems(menu, commit, state);
        menu.showAtMouseEvent(event);
      });
    }

    if (unresolvedByHash.size > 0) {
      const note = section.createDiv({
        cls: "git-note-history-stored-milestones-note"
      });
      note.createSpan({
        text: this.expandedMilestoneHistoryAttempted && this.history.hasMoreHistory
          ? "已读取最多 1000 条历史，仍无法定位这些旧标签。"
          : this.history.hasMoreHistory
          ? "这些旧标签可能位于尚未读取的更早历史，仍缺少路径快照。"
          : "当前分支或改写后的 Git 历史中没有足够信息定位这些旧标签。"
      });
      if (this.history.hasMoreHistory && !this.expandedMilestoneHistoryAttempted) {
        const expand = note.createEl("button", {
          text: this.expandingMilestoneHistory
            ? "正在读取…"
            : "临时读取更多历史"
        });
        expand.disabled = this.expandingMilestoneHistory;
        expand.addEventListener("click", () => {
          void this.loadExpandedMilestoneHistory();
        });
      }
    }
    return total;
  }

  private commitReferenceForMilestone(
    milestone: VersionMilestone
  ): GitCommitVersion {
    return {
      hash: milestone.commitHash,
      shortHash: milestone.commitHash.slice(0, 7),
      authorName: "",
      authorEmail: "",
      authoredAt: milestone.commitAuthoredAt,
      subject: milestone.commitSubject || milestone.label,
      historicalPath: milestone.historicalPath,
      changeType: "M",
      addedLines: 0,
      deletedLines: 0,
      trailers: {}
    };
  }

  private async loadExpandedMilestoneHistory(): Promise<void> {
    const file = this.targetFile;
    if (!file || this.expandingMilestoneHistory) return;
    const expansionGeneration = ++this.milestoneExpansionGeneration;
    const refreshGeneration = this.refreshGeneration;
    this.expandingMilestoneHistory = true;
    this.render();
    try {
      const history = await this.plugin.gitClient.loadFileHistory(file, 1000);
      if (
        expansionGeneration !== this.milestoneExpansionGeneration
        || refreshGeneration !== this.refreshGeneration
        || file !== this.targetFile
      ) return;
      await this.plugin.hydrateVersionMilestones(history.context, history.commits);
      if (
        expansionGeneration !== this.milestoneExpansionGeneration
        || refreshGeneration !== this.refreshGeneration
        || file !== this.targetFile
      ) return;
      this.expandedMilestoneHistoryAttempted = true;
      this.history = history;
      this.pathTransitions = buildPathTransitions(history.commits);
      this.effectiveGroups = groupEffectiveVersions(
        history.commits,
        this.plugin.getFileReviewState(history.context),
        this.commitContents
      );
      this.timeMachinePosition = Math.min(
        this.timeMachinePosition,
        this.timelineCommits().length
      );
      this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
      void this.refineEffectiveGroups(refreshGeneration);
      this.scheduleContentSearch();
    } catch (error) {
      new Notice(`读取更多历史失败：${errorMessage(error)}`, 8000);
    } finally {
      if (expansionGeneration === this.milestoneExpansionGeneration) {
        this.expandingMilestoneHistory = false;
        if (file === this.targetFile) this.render();
      }
    }
  }

  private renderEffectiveGroupRow(
    container: HTMLElement,
    group: EffectiveVersionGroup,
    index: number,
    visibleGroups: EffectiveVersionGroup[],
    state: FileReviewState
  ): void {
    const representative = group.representative;
    const row = container.createDiv({
      cls: `git-note-history-commit git-note-history-effective-group ${index === this.selectedIndex ? "is-keyboard-selected" : ""}`
    });
    const trigger = row.createEl("button", {
      cls: "git-note-history-row-trigger",
      attr: {
        type: "button",
        "aria-label": `${group.summary}, ${formatCommitTime(representative.authoredAt, true)}`
      }
    });
    trigger.createSpan({
      cls: "git-note-history-row-trigger-label",
      text: group.summary
    });
    trigger.addEventListener("focus", () => this.selectRow(row, index));
    const rail = row.createDiv({ cls: "git-note-history-rail" });
    const size = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(group.addedLines + group.deletedLines + 1) / 4)));
    const dot = rail.createSpan({ cls: `git-note-history-dot change-${representative.changeType.toLowerCase()} size-${size}` });
    setIcon(dot, group.isMilestone ? "diamond" : group.commits.length > 1 ? "layers-3" : "git-commit-horizontal");

    const content = row.createDiv({ cls: "git-note-history-commit-content" });
    const top = content.createDiv({ cls: "git-note-history-commit-top" });
    top.createSpan({ cls: "git-note-history-commit-subject", text: group.summary });
    if (this.plugin.settings.showCommitStats) {
      const stats = top.createSpan({ cls: "git-note-history-commit-stats" });
      stats.createSpan({ cls: "is-added", text: `+${group.addedLines}` });
      stats.createSpan({ cls: "is-removed", text: `−${group.deletedLines}` });
    }
    const meta = content.createDiv({ cls: "git-note-history-commit-meta" });
    meta.createSpan({ text: formatCommitTime(representative.authoredAt) });
    meta.createSpan({ text: representative.authorName });
    if (group.commits.length > 1) meta.createSpan({ text: `${group.commits.length} 个 commit` });
    if (group.duplicateCount > 0) meta.createSpan({ text: `${group.duplicateCount} 个重复` });
    const contentMatch = group.commits.find((commit) => this.contentSearchMatches.has(commit.hash));
    if (contentMatch) this.renderContentSearchMatch(content, contentMatch);
    const pathChange = group.commits.find((commit) =>
      this.pathTransitions.some((transition) => transition.commit.hash === commit.hash)
    );
    if (pathChange) this.renderPathTransition(content, pathChange);
    const milestones = group.commits.flatMap((commit) =>
      milestonesForCommit(state, commit.hash, { includeReviewCheckpoint: false })
    );
    if (milestones.length > 0) {
      const badges = content.createDiv({ cls: "git-note-history-badges" });
      this.renderMilestoneBadges(
        badges,
        milestones,
        (milestone) => group.commits.find(
          (commit) => commit.hash === milestone.commitHash
        )
      );
    }

    const actions = row.createDiv({ cls: "ap-row-actions git-note-history-row-actions" });
    if (group.commits.length > 1) {
      const expand = actions.createEl("button", {
        cls: this.expandedGroups.has(group.id) ? "clickable-icon is-active" : "clickable-icon",
        attr: { "aria-label": this.expandedGroups.has(group.id) ? "收起原始提交" : "展开原始提交" }
      });
      setIcon(expand, this.expandedGroups.has(group.id) ? "chevron-up" : "chevron-down");
      expand.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.expandedGroups.has(group.id)) this.expandedGroups.delete(group.id);
        else this.expandedGroups.add(group.id);
        this.render();
      });
    }
    const more = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "更多比较与版本操作" } });
    setIcon(more, "ellipsis");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openEffectiveGroupMenu(event, group, index, visibleGroups, state);
    });
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      this.selectRow(row, index);
      void this.openEffectiveGroupComparison(group, index, visibleGroups);
    });
    row.addEventListener("click", () => {
      this.selectRow(row, index);
      void this.openEffectiveGroupComparison(group, index, visibleGroups);
    });

    if (this.expandedGroups.has(group.id)) {
      const members = container.createDiv({ cls: "git-note-history-effective-members" });
      group.commits.forEach((commit, memberIndex) => {
        const member = members.createEl("button", { cls: "git-note-history-effective-member" });
        member.createSpan({ text: commit.subject || commit.shortHash });
        member.createSpan({ text: `${formatCommitTime(commit.authoredAt)} · ${commit.shortHash}` });
        if (memberIndex > 0 && this.commitContents.get(commit.hash) === this.commitContents.get(group.commits[memberIndex - 1]!.hash)) {
          member.createSpan({ cls: "git-note-history-duplicate-badge", text: "内容重复" });
        }
        if (this.contentSearchMatches.has(commit.hash)) {
          const scope = this.contentSearchMatches.get(commit.hash)?.scope;
          member.createSpan({
            cls: "git-note-history-content-match-badge",
            text: scope === "properties" ? "属性命中" : "正文命中"
          });
        }
        member.addEventListener("click", () => void this.openAgainstWorking(commit));
      });
    }
  }

  private async openEffectiveGroupComparison(
    group: EffectiveVersionGroup,
    index: number,
    groups: EffectiveVersionGroup[]
  ): Promise<void> {
    if (!this.targetFile || !this.history) return;
    const older = groups[index + 1]?.representative;
    if (!older) {
      await this.openAgainstWorking(group.representative);
      return;
    }
    await this.plugin.openDetail({
      filePath: this.targetFile.path,
      repositoryRoot: this.history.context.repositoryRoot,
      base: { kind: "commit", commit: older },
      target: { kind: "commit", commit: group.representative },
      initialMode: this.plugin.getFileReviewState(this.history.context).detailMode ?? this.plugin.settings.defaultDetailMode
    });
  }

  private openEffectiveGroupMenu(
    event: MouseEvent,
    group: EffectiveVersionGroup,
    index: number,
    groups: EffectiveVersionGroup[],
    state: FileReviewState
  ): void {
    if (!this.history) return;
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle("查看跨文件编辑会话")
      .setIcon("git-pull-request-arrow")
      .onClick(() => void this.plugin.openWorkEvent({
        repositoryRoot: this.history!.context.repositoryRoot,
        ...(this.targetFile ? { anchorVaultPath: this.targetFile.path } : {}),
        anchorHistoricalPath: group.representative.historicalPath,
        source: {
          kind: "commit",
          commitHash: group.representative.hash,
          aggregation: "session",
          milestoneHashes: namedMilestoneEvents(state).map(
            (milestone) => milestone.commitHash
          )
        }
      })));
    menu.addItem((item) => item
      .setTitle("创建只读时间胶囊")
      .setIcon("boxes")
      .onClick(() => this.confirmHistoricalSandbox(group.representative)));
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle("查看这组变化")
      .setIcon("git-compare-arrows")
      .onClick(() => void this.openEffectiveGroupComparison(group, index, groups)));
    menu.addItem((item) => item
      .setTitle("与当前工作区比较")
      .setIcon("file-diff")
      .onClick(() => void this.openAgainstWorking(group.representative)));
    const checkpointHash = state.reviewCheckpoint?.commitHash;
    const checkpoint = checkpointHash
      ? this.history.commits.find((commit) => commit.hash === checkpointHash)
      : undefined;
    if (checkpoint && checkpoint.hash !== group.representative.hash) {
      menu.addItem((item) => item
        .setTitle("与上次复查点比较")
        .setIcon("inbox")
        .onClick(() => void this.openCommitPair(checkpoint, group.representative)));
    }
    this.addPreviousMilestoneCompareItems(menu, group.representative, state);
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(state.baselineHash === group.representative.hash ? "取消比较基线" : "设为比较基线")
      .setIcon("star")
      .onClick(async () => {
        await this.plugin.setBaseline(
          this.history!.context,
          state.baselineHash === group.representative.hash ? null : group.representative
        );
        this.render();
      }));
    this.addMilestoneMenuItems(menu, group.representative, state);
    menu.showAtMouseEvent(event);
  }

  private async openCommitPair(base: GitCommitVersion, target: GitCommitVersion): Promise<void> {
    if (!this.targetFile || !this.history) return;
    await this.plugin.openDetail({
      filePath: this.targetFile.path,
      repositoryRoot: this.history.context.repositoryRoot,
      base: { kind: "commit", commit: base },
      target: { kind: "commit", commit: target },
      initialMode: this.plugin.settings.defaultDetailMode
    });
  }

  private async createHistoricalSandbox(
    commit: GitCommitVersion
  ): Promise<void> {
    if (!this.history) return;
    try {
      const before = this.plugin.getHistoricalSandboxes().length;
      const record = await this.plugin.createHistoricalSandbox(
        this.history.context,
        commit
      );
      const reused = this.plugin.getHistoricalSandboxes().length === before;
      new Notice(
        reused
          ? `已打开现有时间胶囊「${record.name}」。`
          : `只读时间胶囊「${record.name}」已创建。`
      );
    } catch (error) {
      new Notice(
        `创建历史沙盒失败：${error instanceof Error ? error.message : String(error)}`,
        10000
      );
    }
  }

  private confirmHistoricalSandbox(commit: GitCommitVersion): void {
    new ConfirmActionModal(
      this.app,
      "创建整套历史 Vault 的只读时间胶囊？",
      `将从 ${commit.shortHash} 创建一个隔离 Git worktree，可能需要复制较多附件并占用磁盘空间。当前 Vault 不会 checkout；历史社区插件会被禁用。`,
      "创建时间胶囊",
      () => this.createHistoricalSandbox(commit)
    ).open();
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "git-note-history-header" });
    const title = header.createDiv({ cls: "git-note-history-title-row" });
    const brand = title.createDiv({ cls: "git-note-history-brand" });
    setIcon(brand.createSpan(), "git-commit-horizontal");
    brand.createEl("h4", { text: "版本历史" });

    const controls = title.createDiv({ cls: "git-note-history-header-actions" });
    if (this.targetFile && this.history) {
      const segment = controls.createDiv({ cls: "ap-seg git-note-history-scope", attr: { role: "group", "aria-label": "显示范围" } });
      const scopes: Array<[boolean, string]> = [[false, "全部"], [true, "里程碑"]];
      for (const [milestonesOnly, label] of scopes) {
        const button = segment.createEl("button", {
          cls: this.showNamedMilestonesOnly === milestonesOnly ? "is-active" : "",
          text: label,
          attr: { "aria-pressed": String(this.showNamedMilestonesOnly === milestonesOnly) }
        });
        button.addEventListener("click", () => {
          if (this.showNamedMilestonesOnly === milestonesOnly) return;
          this.showNamedMilestonesOnly = milestonesOnly;
          this.stopTimeMachinePlayback(false);
          this.timeMachinePosition = this.timelineCommits().length;
          this.selectedIndex = 0;
          this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
          this.render();
        });
      }
    }
    const more = controls.createEl("button", {
      cls: this.loading ? "clickable-icon is-loading" : "clickable-icon",
      attr: { "aria-label": "更多", "aria-haspopup": "menu", "aria-busy": String(this.loading) }
    });
    setIcon(more, this.loading ? "loader-circle" : "ellipsis");
    more.addEventListener("click", event => this.openMoreMenu(event, this.targetFile));

    if (this.targetFile) header.createDiv({ cls: "git-note-history-file-path", text: this.targetFile.path });
    this.renderPathHistory(header);

    const searchRow = header.createDiv({ cls: "git-note-history-search" });
    const search = new SearchComponent(searchRow);
    search.setPlaceholder("搜索版本或历史内容").setValue(this.query).onChange((value) => {
      this.query = value.trim();
      this.selectedIndex = 0;
      this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
      this.scheduleContentSearch();
      this.render();
    });
    if (this.query) {
      const status = header.createDiv({
        cls: `git-note-history-content-search-status ${this.contentSearchLoading ? "is-loading" : ""}`,
        attr: { role: "status", "aria-live": "polite" }
      });
      const icon = status.createSpan();
      setIcon(icon, this.contentSearchLoading ? "loader-circle" : this.query.length < 2 ? "info" : "search-check");
      if (this.query.length < 2) {
        status.createSpan({ text: "输入至少 2 个字符后搜索历史内容；当前仅匹配版本信息。" });
      } else if (this.contentSearchLoading) {
        status.createSpan({
          text: `正在搜索历史内容 ${this.contentSearchScanned}/${this.contentSearchTotal} · 已命中 ${this.contentSearchMatches.size}`
        });
      } else {
        const currentMatch = this.currentContentMatch();
        const failed = this.contentSearchFailed > 0 ? ` · ${this.contentSearchFailed} 个版本不可读` : "";
        const working = currentMatch ? " · 当前工作区命中" : "";
        status.createSpan({
          text: `历史内容命中 ${this.contentSearchMatches.size} 个版本 · 已检查 ${this.contentSearchScanned}${working}${failed}`
        });
      }
    }
  }

  private openMoreMenu(event: MouseEvent, file: TFile | null): void {
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle("跟随当前笔记")
      .setIcon("scan-eye")
      .setChecked(this.followActiveNote)
      .onClick(() => {
        this.followActiveNote = !this.followActiveNote;
        this.render();
      }));
    menu.addItem(item => item.setTitle("刷新").setIcon("refresh-cw").onClick(() => void this.refresh()));
    if (file && this.leaf.getRoot() !== this.app.workspace.rootSplit) {
      menu.addItem(item => item.setTitle("在中央完整打开").setIcon("panel-top-open").onClick(() => void this.plugin.activateHistoryInMain(file)));
    }
    if (!file) {
      menu.showAtMouseEvent(event);
      return;
    }
    menu.addSeparator();
    this.addReviewMenuItems(menu);
    if (this.history && this.timelineCommits().length > 0) {
      menu.addItem(item => item
        .setTitle("笔记时光机")
        .setIcon("history")
        .setChecked(this.timeMachineExpanded)
        .onClick(() => {
          this.timeMachineExpanded = !this.timeMachineExpanded;
          if (!this.timeMachineExpanded) this.stopTimeMachinePlayback(false);
          this.render();
        }));
    }
    menu.addItem(item => item
      .setTitle("显示原始提交")
      .setIcon("git-commit-horizontal")
      .setChecked(this.showRawCommits)
      .onClick(() => {
        this.showRawCommits = !this.showRawCommits;
        this.timeMachinePosition = this.timelineCommits().length;
        this.selectedIndex = 0;
        this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
        this.render();
      }));
    const basketCount = this.plugin.getRecoveryBasketCount(file.path);
    menu.addItem(item => item
      .setTitle(basketCount > 0 ? `恢复篮子（${basketCount}）` : "恢复篮子")
      .setIcon("shopping-basket")
      .onClick(() => void this.plugin.openRecoveryBasket(file)));
    menu.addSeparator();
    if (this.plugin.settings.showLabTools) {
      menu.addItem(item => item.setTitle("追踪内容从哪一版变化").setIcon("scan-search").onClick(() => this.plugin.openKnowledgeTraceSetup(file)));
      menu.addItem(item => item.setTitle("查看版本批注").setIcon("message-square-text").onClick(() => void this.plugin.openReviewAnnotations(file)));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("查看全部历史来源").setIcon("layers-3").onClick(() => void this.plugin.openHistorySources(file)));
      menu.addItem(item => item.setTitle("来源与复查状态").setIcon("scan-eye").onClick(() => void this.plugin.openProvenanceLens(file)));
      menu.addItem(item => item.setTitle("知识图谱时间机").setIcon("orbit").onClick(() => void this.plugin.openKnowledgeGraphTimeMachine(file)));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("历史健康检查").setIcon("activity").onClick(() => void this.plugin.openHistoryHealth(file)));
    }
    menu.addItem(item => item.setTitle("恢复记录与撤销").setIcon("history").onClick(() => new RestoreHistoryModal(this.app, this.plugin).open()));
    menu.addItem(item => item.setTitle("插件设置").setIcon("settings").onClick(() => {
      const settings = (this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } }).setting;
      settings?.open();
      settings?.openTabById(this.plugin.manifest.id);
    }));
    menu.showAtMouseEvent(event);
  }

  private renderPathHistory(container: HTMLElement): void {
    if (this.pathTransitions.length === 0) return;
    const disclosure = container.createEl("button", {
      cls: "git-note-history-path-disclosure",
      attr: {
        "aria-expanded": String(this.pathHistoryExpanded),
        "aria-label": `${this.pathHistoryExpanded ? "收起" : "展开"}笔记路径轨迹`
      }
    });
    setIcon(disclosure.createSpan(), "folder-tree");
    disclosure.createSpan({ text: "路径轨迹" });
    disclosure.createSpan({
      cls: "git-note-history-path-count",
      text: `${this.pathTransitions.length} 次`
    });
    const chevron = disclosure.createSpan({ cls: "git-note-history-path-chevron" });
    setIcon(chevron, this.pathHistoryExpanded ? "chevron-up" : "chevron-down");
    disclosure.addEventListener("click", () => {
      this.pathHistoryExpanded = !this.pathHistoryExpanded;
      this.render();
    });
    if (!this.pathHistoryExpanded) return;

    const panel = container.createDiv({ cls: "git-note-history-path-history" });
    for (const transition of this.pathTransitions) {
      const item = panel.createEl("button", {
        cls: "git-note-history-path-event",
        attr: {
          "aria-label": `${transition.kind === "copy" ? "复制来源" : "重命名"}：${transition.fromPath} 到 ${transition.toPath}`
        }
      });
      const meta = item.createDiv({ cls: "git-note-history-path-event-meta" });
      meta.createSpan({
        cls: `git-note-history-path-kind is-${transition.kind}`,
        text: transition.kind === "copy" ? "复制来源" : "重命名"
      });
      meta.createSpan({
        text: `${formatCommitTime(transition.commit.authoredAt, true)} · ${transition.commit.shortHash}`
      });
      const route = item.createDiv({ cls: "git-note-history-path-route" });
      route.createSpan({
        text: compactHistoryPath(transition.fromPath),
        attr: { title: transition.fromPath }
      });
      setIcon(route.createSpan({ cls: "git-note-history-path-arrow" }), "arrow-right");
      route.createSpan({
        text: compactHistoryPath(transition.toPath),
        attr: { title: transition.toPath }
      });
      item.addEventListener("click", () => {
        void this.openCommitPair(transition.previous, transition.commit);
      });
    }
  }

  private renderPathTransition(container: HTMLElement, commit: GitCommitVersion): void {
    const transition = this.pathTransitions.find((candidate) => candidate.commit.hash === commit.hash);
    if (!transition) return;
    const route = container.createDiv({
      cls: "git-note-history-inline-path",
      attr: { title: `${transition.fromPath} → ${transition.toPath}` }
    });
    setIcon(route.createSpan({ cls: "git-note-history-inline-path-icon" }), transition.kind === "copy" ? "copy" : "folder-input");
    route.createSpan({
      cls: "git-note-history-inline-path-kind",
      text: transition.kind === "copy" ? "复制来源" : "路径变更"
    });
    route.createSpan({ text: compactHistoryPath(transition.fromPath) });
    setIcon(route.createSpan({ cls: "git-note-history-path-arrow" }), "arrow-right");
    route.createSpan({ text: compactHistoryPath(transition.toPath) });
  }

  private renderWorkingTreeCard(container: HTMLElement, state: FileReviewState): void {
    if (!this.history || !this.targetFile) return;
    const hasWorkingChanges = this.history.status.staged
      || this.history.status.unstaged
      || this.history.status.untracked
      || this.history.status.conflicted
      || this.history.workingTreeStats.addedLines > 0
      || this.history.workingTreeStats.deletedLines > 0;
    if (!hasWorkingChanges && !state.baselineHash) return;
    const card = container.createDiv({ cls: "git-note-history-working-card" });
    const title = card.createDiv({ cls: "git-note-history-working-title" });
    const icon = title.createSpan();
    setIcon(icon, this.history.status.conflicted ? "triangle-alert" : "file-pen-line");
    title.createSpan({ text: "当前工作区" });
    const status = title.createSpan({ cls: "git-note-history-working-status", text: statusLabel(this.history) });
    if (this.history.status.conflicted) status.addClass("is-conflicted");

    const meta = card.createDiv({ cls: "git-note-history-working-meta" });
    meta.createSpan({ text: this.history.branch });
    if (this.plugin.settings.showCommitStats) {
      meta.createSpan({ cls: "is-added", text: `+${this.history.workingTreeStats.addedLines}` });
      meta.createSpan({ cls: "is-removed", text: `−${this.history.workingTreeStats.deletedLines}` });
    }

    const actions = card.createDiv({ cls: "git-note-history-working-actions" });
    const baseline = state.baselineHash
      ? this.knownMilestoneCommits(state)
          .find((commit) => commit.hash === state.baselineHash)
      : undefined;
    const defaultBase = baseline ?? this.history.commits[0];
    if (defaultBase) {
      const review = actions.createEl("button", { text: baseline ? "与基线比较" : "查看当前改动" });
      review.addEventListener("click", () => void this.openAgainstWorking(defaultBase));
    }
    const latestMilestone = previousNamedMilestone(this.history.commits, state);
    if (latestMilestone && latestMilestone.commit.hash !== defaultBase?.hash) {
      const compareMilestone = actions.createEl("button", { text: "与最近里程碑比较" });
      compareMilestone.addEventListener("click", () => void this.openAgainstWorking(latestMilestone.commit));
    }
    const event = actions.createEl("button", { text: "查看本次工作" });
    event.addEventListener("click", () => void this.plugin.openWorkEvent({
      repositoryRoot: this.history!.context.repositoryRoot,
      anchorVaultPath: this.targetFile!.path,
      source: { kind: "working" }
    }));
    const workspace = actions.createEl("button", { text: "未提交笔记" });
    workspace.addEventListener("click", () => void this.plugin.activateWorkspaceReview());
    if (this.history.status.conflicted) {
      const resolve = actions.createEl("button", { cls: "mod-warning", text: "解决冲突" });
      resolve.addEventListener("click", () => void this.plugin.activateConflictResolver(this.targetFile));
    }

    if (baseline) {
      const baselineRow = card.createDiv({ cls: "git-note-history-baseline-row" });
      const star = baselineRow.createSpan();
      setIcon(star, "star");
      const baselineMilestone = milestonesForCommit(
        state,
        baseline.hash,
        { includeReviewCheckpoint: false }
      )[0];
      baselineRow.createSpan({
        text: `比较基线：${baseline.shortHash} ${baselineMilestone?.label ?? baseline.subject}`
      });
    }
  }

  private renderTimeMachine(container: HTMLElement): void {
    if (!this.history || !this.targetFile || this.timelineCommits().length === 0) return;
    const state = this.plugin.getFileReviewState(this.history.context);
    const chronological = [...this.timelineCommits()].reverse();
    const max = chronological.length;
    this.timeMachinePosition = Math.max(0, Math.min(max, this.timeMachinePosition));
    const card = container.createDiv({
      cls: `git-note-history-time-machine ${this.timeMachineExpanded ? "is-expanded" : "is-collapsed"}`
    });
    const header = card.createDiv({ cls: "git-note-history-time-machine-header" });
    const heading = header.createEl("button", {
      cls: "git-note-history-time-machine-title",
      attr: {
        "aria-expanded": String(this.timeMachineExpanded),
        "aria-label": this.timeMachineExpanded ? "收起时光机" : "展开时光机"
      }
    });
    setIcon(heading.createSpan(), this.timeMachineExpanded ? "chevron-down" : "chevron-right");
    heading.createSpan({ text: "笔记时光机" });
    heading.createSpan({
      cls: "git-note-history-time-machine-count",
      text: `${chronological.length} 个${this.showRawCommits ? "提交" : "有效版本"}`
    });

    heading.addEventListener("click", () => {
      this.timeMachineExpanded = !this.timeMachineExpanded;
      if (!this.timeMachineExpanded) this.stopTimeMachinePlayback(false);
      this.render();
    });

    if (!this.timeMachineExpanded) return;

    const playback = header.createEl("button", {
      cls: this.playbackTimer !== null ? "clickable-icon is-active" : "clickable-icon",
      attr: {
        "aria-label": this.playbackTimer !== null ? "暂停版本播放" : "从旧到新播放版本",
        "aria-pressed": String(this.playbackTimer !== null)
      }
    });
    setIcon(playback, this.playbackTimer !== null ? "pause" : "play");
    playback.addEventListener("click", () => {
      if (this.playbackTimer !== null) this.stopTimeMachinePlayback();
      else this.startTimeMachinePlayback();
    });

    const selected = chronological[this.timeMachinePosition];
    const labelRow = card.createDiv({ cls: "git-note-history-time-machine-label" });
    const versionLabel = labelRow.createSpan({
      cls: "git-note-history-time-machine-version",
      text: selected
        ? `${selected.shortHash} · ${this.commitDisplayLabel(selected, state)}`
        : "当前工作区"
    });
    const dateLabel = labelRow.createSpan({
      cls: "git-note-history-time-machine-date",
      text: selected ? formatCommitTime(selected.authoredAt, true) : "现在"
    });

    const listId = "git-note-history-time-marks";
    const slider = card.createEl("input", {
      cls: "git-note-history-time-slider",
      type: "range",
      attr: {
        min: "0",
        max: String(max),
        step: "1",
        value: String(this.timeMachinePosition),
        list: listId,
        "aria-label": "选择要浏览的笔记版本"
      }
    });
    const marks = card.createEl("datalist", { attr: { id: listId } });
    chronological.forEach((commit, index) => {
      if (
        index === 0
        || hasNamedMilestone(state, commit.hash)
        || ["R", "C"].includes(commit.changeType)
        || commit.addedLines + commit.deletedLines >= 20
      ) {
        marks.createEl("option", { attr: { value: String(index), label: commit.shortHash } });
      }
    });
    marks.createEl("option", { attr: { value: String(max), label: "现在" } });

    const updateLabels = () => {
      const position = Number.parseInt(slider.value, 10);
      this.timeMachinePosition = Number.isFinite(position) ? position : max;
      const commit = chronological[this.timeMachinePosition];
      versionLabel.setText(
        commit ? `${commit.shortHash} · ${this.commitDisplayLabel(commit, state)}` : "当前工作区"
      );
      dateLabel.setText(commit ? formatCommitTime(commit.authoredAt, true) : "现在");
    };
    slider.addEventListener("input", () => {
      this.stopTimeMachinePlayback(false);
      updateLabels();
      this.scheduleTimeMachinePreview();
    });
    slider.addEventListener("change", () => {
      updateLabels();
      void this.openTimeMachinePosition();
    });

    const footer = card.createDiv({ cls: "git-note-history-time-machine-footer" });
    footer.createSpan({ text: "最早" });
    const open = footer.createEl("button");
    setIcon(open.createSpan(), "panel-top-open");
    open.createSpan({ text: "查看此刻" });
    open.addEventListener("click", () => void this.openTimeMachinePosition());
    footer.createSpan({ text: "现在" });
  }

  private commitDisplayLabel(commit: GitCommitVersion, state: FileReviewState): string {
    return milestonesForCommit(
      state,
      commit.hash,
      { includeReviewCheckpoint: false }
    )[0]?.label ?? (commit.subject || "无提交说明");
  }

  private scheduleTimeMachinePreview(): void {
    if (this.timeMachinePreviewTimer !== null) window.clearTimeout(this.timeMachinePreviewTimer);
    this.timeMachinePreviewTimer = window.setTimeout(() => {
      this.timeMachinePreviewTimer = null;
      void this.openTimeMachinePosition();
    }, 180);
  }

  private async openTimeMachinePosition(): Promise<void> {
    if (!this.history || !this.targetFile || this.timelineCommits().length === 0) return;
    const chronological = [...this.timelineCommits()].reverse();
    const selected = chronological[this.timeMachinePosition];
    if (!selected) {
      const latest = chronological.at(-1);
      if (!latest) return;
      await this.plugin.openDetail({
        filePath: this.targetFile.path,
        repositoryRoot: this.history.context.repositoryRoot,
        base: { kind: "commit", commit: latest },
        target: { kind: "working", label: "当前工作区" },
        initialMode: "preview"
      });
      return;
    }
    const previous = chronological[Math.max(0, this.timeMachinePosition - 1)] ?? selected;
    await this.plugin.openDetail({
      filePath: this.targetFile.path,
      repositoryRoot: this.history.context.repositoryRoot,
      base: { kind: "commit", commit: previous },
      target: { kind: "commit", commit: selected },
      initialMode: "preview"
    });
  }

  private startTimeMachinePlayback(): void {
    if (!this.history || this.timelineCommits().length === 0) return;
    const max = this.timelineCommits().length;
    if (this.timeMachinePosition >= max) this.timeMachinePosition = 0;
    void this.openTimeMachinePosition();
    this.playbackTimer = window.setInterval(() => {
      if (this.timeMachinePosition >= max) {
        this.stopTimeMachinePlayback();
        return;
      }
      this.timeMachinePosition += 1;
      this.render();
      void this.openTimeMachinePosition();
    }, 1400);
    this.render();
  }

  private stopTimeMachinePlayback(render = true): void {
    if (this.playbackTimer !== null) window.clearInterval(this.playbackTimer);
    this.playbackTimer = null;
    if (render && this.history) this.render();
  }

  private renderCompareBar(container: HTMLElement): void {
    if (!this.history || this.compareSelection.size === 0) return;
    const bar = container.createDiv({ cls: "git-note-history-compare-bar" });
    bar.createSpan({ text: `已选 ${this.compareSelection.size}/2 个版本` });
    const clear = bar.createEl("button", { text: "清除" });
    clear.addEventListener("click", () => {
      this.compareSelection.clear();
      this.render();
    });
    if (this.compareSelection.size === 2) {
      const compare = bar.createEl("button", { cls: "mod-cta", text: "比较两个版本" });
      compare.addEventListener("click", () => void this.openSelectedComparison());
    }
  }

  private renderCommitRow(
    container: HTMLElement,
    commit: GitCommitVersion,
    filteredIndex: number,
    state: FileReviewState
  ): void {
    const row = container.createDiv({
      cls: `git-note-history-commit ${filteredIndex === this.selectedIndex ? "is-keyboard-selected" : ""}`
    });
    const trigger = row.createEl("button", {
      cls: "git-note-history-row-trigger",
      attr: {
        type: "button",
        "aria-label": `${commit.subject}, ${formatCommitTime(commit.authoredAt, true)}`
      }
    });
    trigger.createSpan({
      cls: "git-note-history-row-trigger-label",
      text: commit.subject || "（无提交说明）"
    });
    trigger.addEventListener("focus", () => this.selectRow(row, filteredIndex));
    const rail = row.createDiv({ cls: "git-note-history-rail" });
    const dot = rail.createSpan({ cls: `git-note-history-dot change-${commit.changeType.toLowerCase()}` });
    setIcon(dot, commit.changeType === "R" ? "file-symlink" : commit.changeType === "C" ? "copy" : "git-commit-horizontal");

    const content = row.createDiv({ cls: "git-note-history-commit-content" });
    const top = content.createDiv({ cls: "git-note-history-commit-top" });
    top.createSpan({ cls: "git-note-history-commit-subject", text: commit.subject || "（无提交说明）" });
    if (this.plugin.settings.showCommitStats) {
      const stats = top.createSpan({ cls: "git-note-history-commit-stats" });
      stats.createSpan({ cls: "is-added", text: `+${commit.addedLines}` });
      stats.createSpan({ cls: "is-removed", text: `−${commit.deletedLines}` });
    }

    const meta = content.createDiv({ cls: "git-note-history-commit-meta" });
    meta.createSpan({ text: formatCommitTime(commit.authoredAt) });
    meta.createSpan({ text: commit.authorName });
    meta.createEl("code", { text: commit.shortHash });
    this.renderContentSearchMatch(content, commit);
    this.renderPathTransition(content, commit);

    const badges = content.createDiv({ cls: "git-note-history-badges" });
    if (state.baselineHash === commit.hash) this.addBadge(badges, "star", "比较基线", "is-baseline");
    this.renderMilestoneBadges(
      badges,
      milestonesForCommit(state, commit.hash, { includeReviewCheckpoint: false }),
      commit
    );
    for (const [key, value] of Object.entries(commit.trailers)) {
      this.addBadge(badges, key === "agent" ? "bot" : "shield-check", value, `is-${key}`);
    }

    const actions = row.createDiv({ cls: "ap-row-actions git-note-history-row-actions" });
    const select = actions.createEl("button", {
      cls: this.compareSelection.has(commit.hash) ? "clickable-icon is-active" : "clickable-icon",
      attr: { "aria-label": "选择用于双版本比较", "aria-pressed": String(this.compareSelection.has(commit.hash)) }
    });
    setIcon(select, "square-stack");
    select.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleCompare(commit.hash);
    });

    const more = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "更多操作" } });
    setIcon(more, "ellipsis");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openCommitMenu(event, commit, state);
    });

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) this.toggleCompare(commit.hash);
      else {
        this.selectRow(row, filteredIndex);
        void this.openAgainstWorking(commit);
      }
    });
    row.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey) this.toggleCompare(commit.hash);
      else {
        this.selectRow(row, filteredIndex);
        void this.openAgainstWorking(commit);
      }
    });
    row.addEventListener("mouseenter", () => this.scheduleHoverPreview(row, commit));
    row.addEventListener("mouseleave", () => {
      this.cancelHoverPreview(commit.hash);
      row.querySelector(".git-note-history-hover-preview")?.remove();
    });
  }

  private scheduleHoverPreview(row: HTMLElement, commit: GitCommitVersion): void {
    if (!this.history) return;
    this.cancelHoverPreview(this.hoverHash);
    this.hoverHash = commit.hash;
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      void this.showHoverPreview(row, commit);
    }, 450);
  }

  private cancelHoverPreview(hash: string): void {
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (this.hoverHash === hash) this.hoverHash = "";
  }

  private async showHoverPreview(row: HTMLElement, commit: GitCommitVersion): Promise<void> {
    if (!this.history || !row.isConnected || !row.matches(":hover")) return;
    const key = `${commit.hash}:${commit.historicalPath}`;
    let preview = this.hoverPreviewCache.get(key);
    if (!preview) {
      try {
        const content = await this.plugin.gitClient.getFileContent(
          this.history.context.repositoryRoot,
          commit.hash,
          commit.historicalPath
        );
        preview = content.replace(/^---[\s\S]*?---\s*/, "").trim().slice(0, 420);
        this.hoverPreviewCache.set(key, preview);
      } catch {
        return;
      }
    }
    if (!row.isConnected || !row.matches(":hover")) return;
    row.querySelector(".git-note-history-hover-preview")?.remove();
    row.createDiv({ cls: "git-note-history-hover-preview", text: preview || "（空版本）" });
  }

  private addBadge(container: HTMLElement, icon: string, text: string, className: string): void {
    const badge = container.createSpan({ cls: `git-note-history-badge ${className}` });
    setIcon(badge.createSpan(), icon);
    badge.createSpan({ text });
  }

  private renderMilestoneBadges(
    container: HTMLElement,
    milestones: VersionMilestone[],
    commit?: GitCommitVersion | ((milestone: VersionMilestone) => GitCommitVersion | undefined)
  ): void {
    for (const milestone of milestones.slice(0, 2)) {
      this.renderMilestoneBadge(
        container,
        milestone,
        typeof commit === "function" ? commit(milestone) : commit
      );
    }
    if (milestones.length > 2) {
      container.createSpan({
        cls: "git-note-history-badge git-note-history-milestone-overflow",
        text: `+${milestones.length - 2}`,
        attr: {
          title: milestones.slice(2).map((milestone) => milestone.label).join("、")
        }
      });
    }
  }

  private renderMilestoneBadge(
    container: HTMLElement,
    milestone: VersionMilestone,
    commit?: GitCommitVersion
  ): void {
    const kind = milestone.kind;
    const eventTime = formatCommitTime(milestone.occurredAt, true);
    const tooltip = [
      milestoneKindLabel(kind),
      `事件时间 ${eventTime}`,
      milestone.note ?? ""
    ].filter(Boolean).join(" · ");
    const badge = commit
      ? container.createEl("button", {
          cls: `git-note-history-badge git-note-history-milestone-badge is-${kind}`,
          attr: {
            type: "button",
            title: tooltip,
            "aria-label": `编辑里程碑「${milestone.label}」，事件时间 ${eventTime}`
          }
        })
      : container.createSpan({
          cls: `git-note-history-badge git-note-history-milestone-badge is-${kind}`,
          attr: { title: tooltip }
        });
    setIcon(badge.createSpan(), milestoneKindIcon(kind));
    badge.createSpan({ text: milestone.label });
    if (commit) {
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openMilestoneEditor(commit, milestone);
      });
    }
  }

  private openMilestoneEditor(
    commit: GitCommitVersion,
    current?: VersionMilestone
  ): void {
    if (!this.history || !this.targetFile) return;
    const file = this.targetFile;
    new VersionMilestoneModal(
      this.app,
      current,
      async (milestone) => {
        const context = await this.plugin.gitClient.resolveFileContext(file);
        await this.plugin.setVersionMilestone(
          context,
          commit,
          current?.id ?? null,
          milestone
        );
        this.plugin.refreshOpenViews();
        if (
          this.history?.context.repositoryRoot !== context.repositoryRoot
          || this.history.context.repositoryRelativePath !== context.repositoryRelativePath
        ) return;
        this.effectiveGroups = groupEffectiveVersions(
          this.history.commits,
          this.plugin.getFileReviewState(context),
          this.commitContents
        );
        this.timeMachinePosition = Math.min(
          this.timeMachinePosition,
          this.timelineCommits().length
        );
        new Notice(milestone ? `已命名为「${milestone.label}」。` : "已移除里程碑。");
        this.render();
      }
    ).open();
  }

  private addMilestoneMenuItems(
    menu: Menu,
    commit: GitCommitVersion,
    state: FileReviewState
  ): void {
    const milestones = milestonesForCommit(state, commit.hash, {
      includeReviewCheckpoint: false
    });
    for (const milestone of milestones) {
      menu.addItem((item) => item
        .setTitle(`编辑里程碑「${milestone.label}」`)
        .setIcon(milestoneKindIcon(milestone.kind))
        .onClick(() => this.openMilestoneEditor(commit, milestone)));
    }
    menu.addItem((item) => item
      .setTitle(milestones.length > 0 ? "再添加一个里程碑" : "命名这个版本")
      .setIcon("bookmark-plus")
      .onClick(() => this.openMilestoneEditor(commit)));
  }

  private addPreviousMilestoneCompareItems(
    menu: Menu,
    commit: GitCommitVersion,
    state: FileReviewState
  ): void {
    const kinds = [
      "sent",
      "submitted",
      "confirmed",
      "exported",
      "important-draft",
      "custom"
    ] as const;
    const titles = {
      sent: "与上次发送版比较",
      submitted: "与上次材料提交版比较",
      confirmed: "与上次确认版比较",
      exported: "与上次导出版比较",
      "important-draft": "与上个重要草稿比较",
      custom: ""
    };
    for (const kind of kinds) {
      const previous = previousNamedMilestone(
        this.history!.commits,
        state,
        commit.hash,
        kind
      );
      if (!previous) continue;
      menu.addItem((item) => item
        .setTitle(titles[kind] || `与上个里程碑「${previous.milestone.label}」比较`)
        .setIcon(milestoneKindIcon(kind))
        .onClick(() => void this.openCommitPair(previous.commit, commit)));
    }
  }

  private renderContentSearchMatch(container: HTMLElement, commit: GitCommitVersion): void {
    const contentMatch = this.contentSearchMatches.get(commit.hash);
    if (!contentMatch || !this.query) return;
    const { snippet } = contentMatch;
    const match = container.createDiv({ cls: "git-note-history-content-match" });
    const icon = match.createSpan();
    setIcon(icon, "text-search");
    match.createSpan({
      cls: "git-note-history-content-match-scope",
      text: contentMatch.scope === "properties" ? "属性" : "正文"
    });
    const excerpt = match.createSpan({ cls: "git-note-history-content-match-text" });
    const index = snippet.toLocaleLowerCase().indexOf(this.query.toLocaleLowerCase());
    if (index < 0) {
      excerpt.setText(snippet);
      return;
    }
    excerpt.createSpan({ text: snippet.slice(0, index) });
    excerpt.createEl("mark", { text: snippet.slice(index, index + this.query.length) });
    excerpt.createSpan({ text: snippet.slice(index + this.query.length) });
  }

  private openCommitMenu(event: MouseEvent, commit: GitCommitVersion, state: FileReviewState): void {
    if (!this.history) return;
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle("查看本次工作事件")
      .setIcon("git-pull-request-arrow")
      .onClick(() => void this.plugin.openWorkEvent({
        repositoryRoot: this.history!.context.repositoryRoot,
        ...(this.targetFile ? { anchorVaultPath: this.targetFile.path } : {}),
        anchorHistoricalPath: commit.historicalPath,
        source: {
          kind: "commit",
          commitHash: commit.hash,
          aggregation: "commit"
        }
      })));
    menu.addItem((item) => item
      .setTitle("创建只读时间胶囊")
      .setIcon("boxes")
      .onClick(() => this.confirmHistoricalSandbox(commit)));
    if (this.targetFile) {
      menu.addItem((item) => item
        .setTitle("批注这个历史版本")
        .setIcon("message-square-plus")
        .onClick(() => void this.plugin.addCommitReviewAnnotation(this.targetFile!, commit)));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("与当前版本比较").setIcon("git-compare-arrows").onClick(() => void this.openAgainstWorking(commit)));
    this.addPreviousMilestoneCompareItems(menu, commit, state);
    menu.addItem((item) => item.setTitle(state.baselineHash === commit.hash ? "取消比较基线" : "设为比较基线").setIcon("star").onClick(async () => {
      await this.plugin.setBaseline(this.history!.context, state.baselineHash === commit.hash ? null : commit);
      this.render();
    }));
    this.addMilestoneMenuItems(menu, commit, state);
    if (this.targetFile) {
      const file = this.targetFile;
      menu.addItem((item) => item.setTitle("复制版本链接").setIcon("link").onClick(() => void this.plugin.copyVersionLink(file, commit)));
    }
    menu.addItem((item) => item.setTitle("复制完整 commit hash").setIcon("copy").onClick(async () => {
      await navigator.clipboard.writeText(commit.hash);
      new Notice("已复制 commit hash。");
    }));
    menu.showAtMouseEvent(event);
  }

  private toggleCompare(hash: string): void {
    if (this.compareSelection.has(hash)) this.compareSelection.delete(hash);
    else {
      if (this.compareSelection.size >= 2) this.compareSelection.delete(this.compareSelection.values().next().value as string);
      this.compareSelection.add(hash);
    }
    this.render();
  }

  private async openAgainstWorking(commit: GitCommitVersion, mode?: DetailMode): Promise<void> {
    if (!this.targetFile || !this.history) return;
    await this.plugin.openDetail({
      filePath: this.targetFile.path,
      repositoryRoot: this.history.context.repositoryRoot,
      base: { kind: "commit", commit },
      target: { kind: "working", label: "当前工作区" },
      initialMode: mode ?? this.plugin.getFileReviewState(this.history.context).detailMode ?? this.plugin.settings.defaultDetailMode
    });
  }

  private async openSelectedComparison(): Promise<void> {
    if (!this.targetFile || !this.history || this.compareSelection.size !== 2) return;
    const selected = this.history.commits.filter((commit) => this.compareSelection.has(commit.hash));
    if (selected.length !== 2) return;
    const firstIndex = this.history.commits.indexOf(selected[0]!);
    const secondIndex = this.history.commits.indexOf(selected[1]!);
    const base = firstIndex > secondIndex ? selected[0]! : selected[1]!;
    const target = firstIndex > secondIndex ? selected[1]! : selected[0]!;
    await this.plugin.openDetail({
      filePath: this.targetFile.path,
      repositoryRoot: this.history.context.repositoryRoot,
      base: { kind: "commit", commit: base },
      target: { kind: "commit", commit: target },
      initialMode: this.plugin.settings.defaultDetailMode
    });
  }

  private handleKeyboard(event: KeyboardEvent): void {
    const rowTrigger = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(".git-note-history-row-trigger")
      : null;
    if (rowTrigger && isHistoryRowActivationKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      rowTrigger.click();
      return;
    }
    if (
      event.defaultPrevented
      || event.metaKey
      || event.ctrlKey
      || isInteractiveKeyboardTarget(event.target)
      || !this.history
    ) return;
    const filtered = this.filteredTimelineCommits();
    const activationMode = historyActivationMode(event.key);
    if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      this.selectedIndex = Math.min(filtered.length - 1, this.selectedIndex + 1);
      if (this.selectedIndex >= this.visibleTimelineCount) {
        this.visibleTimelineCount = expandTimelineLimit(this.visibleTimelineCount, filtered.length);
      }
      this.render();
    } else if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    } else if (activationMode) {
      const commit = filtered[this.selectedIndex];
      if (!commit) return;
      event.preventDefault();
      void this.openAgainstWorking(commit, activationMode === "preview" ? "preview" : undefined);
    }
  }

  private renderSkeleton(container: HTMLElement): void {
    const status = container.createDiv({
      cls: "git-note-history-loading-state",
      attr: { role: "status", "aria-live": "polite" }
    });
    const icon = status.createSpan({ cls: "git-note-history-state-icon" });
    setIcon(icon, "loader-circle");
    status.createSpan({ text: "正在读取 Git 历史…" });
    const skeleton = container.createDiv({ cls: "git-note-history-skeleton" });
    for (let index = 0; index < 3; index += 1) skeleton.createDiv({ cls: "git-note-history-skeleton-row" });
  }

  private renderTimelineFooter(container: HTMLElement, visible: number, total: number): void {
    if (!this.history) return;
    const hasHiddenRows = visible < total;
    if (!hasHiddenRows && !this.history.hasMoreHistory) return;
    const footer = container.createDiv({
      cls: "git-note-history-timeline-footer",
      attr: { role: "status", "aria-live": "polite" }
    });
    const summary = hasHiddenRows ? `已显示 ${visible} / ${total}` : `已显示 ${visible} 个版本`;
    footer.createSpan({ text: this.history.hasMoreHistory ? `${summary} · 已达读取上限` : summary });
    if (hasHiddenRows) {
      const nextCount = Math.min(DEFAULT_TIMELINE_BATCH_SIZE, total - visible);
      const more = footer.createEl("button", { text: `再显示 ${nextCount} 个` });
      more.addEventListener("click", () => {
        this.visibleTimelineCount = expandTimelineLimit(this.visibleTimelineCount, total);
        this.render();
      });
    }
  }

  private renderState(
    container: HTMLElement,
    iconName: string,
    title: string,
    description: string,
    actionLabel?: string,
    action?: () => void,
    details?: string
  ): void {
    const state = container.createDiv({ cls: "git-note-history-state" });
    const icon = state.createSpan({ cls: "git-note-history-state-icon" });
    setIcon(icon, iconName);
    state.createEl("h5", { text: title });
    state.createEl("p", { text: description });
    if (details) state.createEl("pre", { cls: "git-note-history-state-details", text: details });
    if (actionLabel && action) {
      const button = state.createEl("button", { text: actionLabel });
      button.addEventListener("click", action);
    }
  }
}
