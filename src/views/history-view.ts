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
import { GitCommandError, type GitProblem } from "../git/git-client";
import { tr } from "../i18n";
import { HistoryDemoModal } from "../ui/demo-modal";
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
  if (Number.isNaN(date.getTime())) return tr("更早", "Earlier");
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startToday - startTarget) / 86_400_000);
  if (days === 0) return tr("今天", "Today");
  if (days === 1) return tr("昨天", "Yesterday");
  if (days < 7) return tr("本周", "This week");
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return tr("本月", "This month");
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long" }).format(date);
}

export const GIT_START_GUIDE_URL = "https://github.com/Rexxall/obsidian-git-history-view#starting-with-git";

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
  if (status.conflicted) return tr("存在冲突", "Conflict");
  if (status.untracked) return tr("尚未跟踪", "Not tracked");
  if (status.staged && status.unstaged) return tr("已暂存 + 未暂存", "Staged + unstaged");
  if (status.staged) return tr("已暂存", "Staged");
  if (status.unstaged) return tr("未提交修改", "Uncommitted edits");
  return tr("工作区干净", "Clean");
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
  private errorProblem: GitProblem | "stopped" = "failed";
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
      this.errorProblem = error instanceof GitCommandError ? error.problem : "failed";
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
      this.renderState(container, "file-text", tr("打开一篇 Markdown 笔记", "Open a Markdown note"), tr("版本历史会跟随当前笔记显示。", "History follows the current note."));
      return;
    }
    if (this.loading) {
      this.renderSkeleton(container);
      return;
    }
    if (this.error) {
      this.renderGitProblem(container);
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
          tr("还没有命名里程碑", "No named milestones yet"),
          tr("在重要版本的更多菜单中选择“命名这个版本”。", "Choose \"Name this version\" in an important version's menu."),
          tr("显示全部版本", "Show all versions"),
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
            tr("正在搜索历史内容", "Searching past versions"),
            tr(`已检查 ${this.contentSearchScanned} / ${this.contentSearchTotal} 个版本。`, `Checked ${this.contentSearchScanned} of ${this.contentSearchTotal} versions.`),
            tr("停止搜索", "Stop searching"),
            () => {
              this.cancelContentSearch(false);
              this.render();
            }
          );
          return;
        }
        if (this.currentContentMatch()) {
          this.renderState(
            container,
            "file-pen-line",
            tr("只在当前工作区找到", "Found only in the working copy"),
            tr(`“${this.query}”尚未进入任何可读的 Git 版本。`, `"${this.query}" is not in any readable Git version yet.`)
          );
          return;
        }
        this.renderState(
          container,
          "search-x",
          tr("没有匹配的版本", "No matching versions"),
          tr(`没有找到“${this.query}”。`, `"${this.query}" was not found.`),
          tr("清除搜索", "Clear search"),
          () => {
            this.query = "";
            this.selectedIndex = 0;
            this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
            this.render();
          }
        );
      } else {
        this.renderEmptyHistory(container);
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
    const compare = bar.createEl("button", { text: tr("和当前比较", "Compare with current") });
    compare.addEventListener("click", () => {
      const commit = this.selectedTimelineCommit();
      if (commit) void this.openAgainstWorking(commit);
    });
    const restore = bar.createEl("button", { cls: "mod-cta", text: tr("恢复这一版", "Restore this version") });
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
      target: { kind: "working", label: tr("当前工作区", "Working copy") },
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
    if (key === "working") return { kind: "working", label: tr("当前工作区", "Working copy") };
    const commit = this.history.commits.find((candidate) => candidate.hash === key);
    return commit ? { kind: "commit", commit } : null;
  }

  private lifecycleVersionLabel(key: string): string {
    if (key === "working") return tr("当前工作区", "Working copy");
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
    title.createSpan({ text: tr("内容轨迹", "Content trail") });
    heading.createSpan({
      cls: `git-note-history-content-lifecycle-state ${lifecycle.currentPresent ? "is-present" : "is-removed"}`,
      text: lifecycle.currentPresent ? tr("当前仍存在", "Still present") : tr("当前已删除", "Deleted now")
    });

    const milestones = card.createDiv({ cls: "git-note-history-content-lifecycle-milestones" });
    const addMilestone = (label: string, key: string, tone: string): void => {
      const item = milestones.createDiv({ cls: `git-note-history-content-lifecycle-milestone ${tone}` });
      item.createSpan({ cls: "git-note-history-content-lifecycle-dot" });
      const copy = item.createDiv();
      copy.createSpan({ cls: "git-note-history-content-lifecycle-label", text: label });
      copy.createSpan({ cls: "git-note-history-content-lifecycle-value", text: this.lifecycleVersionLabel(key) });
    };
    addMilestone(tr("首次出现", "First appeared"), lifecycle.firstAppearanceKey!, "is-introduced");
    if (lifecycle.lastPresenceKey !== lifecycle.firstAppearanceKey) {
      addMilestone(
        lifecycle.currentPresent ? tr("延续至", "Continues to") : tr("最后存在", "Last present"),
        lifecycle.lastPresenceKey!,
        "is-last"
      );
    }
    if (lastSpan.removedByKey) addMilestone(tr("随后删除于", "Then deleted in"), lastSpan.removedByKey, "is-removed");

    const notes: string[] = [];
    if (lifecycle.confirmedReappearances > 0) {
      notes.push(tr(`曾重新出现 ${lifecycle.confirmedReappearances} 次`, `Reappeared ${lifecycle.confirmedReappearances} times`));
    }
    if (lifecycle.unknownVersions > 0) {
      notes.push(tr(`${lifecycle.unknownVersions} 个版本无法验证`, `${lifecycle.unknownVersions} versions could not be verified`));
    }
    if (notes.length > 0) {
      card.createDiv({ cls: "git-note-history-content-lifecycle-note", text: notes.join(" · ") });
    }

    const actions = card.createDiv({ cls: "git-note-history-content-lifecycle-actions" });
    if (firstSpan.introducedAfterKey) {
      const introduced = actions.createEl("button", { text: tr("查看首次加入", "View first addition") });
      setIcon(introduced.createSpan(), "git-compare-arrows");
      introduced.addEventListener("click", () => {
        void this.openVersionPair(firstSpan.introducedAfterKey!, firstSpan.firstKey);
      });
    }
    if (lastSpan.removedByKey) {
      const removed = actions.createEl("button", { text: tr("查看删除位置", "View where it was deleted") });
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
        subject: tr("上次复查点", "Last review point"),
        authoredAt: checkpoint.reviewedAt,
        addedLines: 0,
        deletedLines: 0
      };

    const entry = container.createEl("button", {
      cls: "ap-disclosure-row git-note-history-review-inbox",
      attr: { type: "button", "aria-label": tr("审阅自上次复查以来的变化", "Review changes since the last review") }
    });
    setIcon(entry.createSpan({ cls: "ap-disclosure-icon" }), "inbox");
    const copy = entry.createSpan({ cls: "ap-disclosure-copy" });
    copy.createSpan({
      cls: "ap-disclosure-title",
      text: tr(`待复查 ${pendingGroups.length} 个版本${workingChanged ? "＋当前工作区" : ""}`, `${pendingGroups.length} versions to review${workingChanged ? " + working copy" : ""}`)
    });
    copy.createSpan({
      cls: "ap-disclosure-sub",
      text: tr(`自 ${formatCommitTime(checkpoint.reviewedAt, true)}`, `Since ${formatCommitTime(checkpoint.reviewedAt, true)}`)
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
        .setTitle(tr("设为复查起点", "Set as review start"))
        .setIcon("circle-dot-dashed")
        .onClick(() => void this.markCurrentReviewed(latest)));
      return;
    }
    menu.addItem(item => item
      .setTitle(tr("标记已复查", "Mark as reviewed"))
      .setIcon("check-check")
      .onClick(() => void this.markCurrentReviewed(latest)));
    menu.addItem(item => item
      .setTitle(tr("清除复查点", "Clear review point"))
      .setIcon("x")
      .onClick(async () => {
        await this.plugin.clearReviewCheckpoint(history.context);
        this.render();
      }));
  }

  private async markCurrentReviewed(latest: GitCommitVersion): Promise<void> {
    if (!this.history) return;
    await this.plugin.markReviewed(this.history.context, latest, this.currentFingerprint);
    new Notice(tr(`已复查到 ${latest.shortHash}。`, `Reviewed up to ${latest.shortHash}.`));
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
    title.createSpan({ text: tr("当前历史列表外的里程碑", "Milestones outside the current list") });
    heading.createSpan({
      text: tr(`${total} 个版本`, `${total} versions`)
    });
    if (total > 3 && !this.showNamedMilestonesOnly && !this.query) {
      const toggle = heading.createEl("button", {
        text: this.storedMilestonesExpanded ? tr("收起", "Collapse") : tr("显示全部", "Show all")
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
          "aria-label": tr(`将${milestones.map((milestone) => milestone.label).join("、")}与当前工作区比较`, `Compare ${milestones.map((milestone) => milestone.label).join(", ")} with the working copy`)
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
        attr: { "aria-label": tr("更多里程碑操作", "More milestone actions") }
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
        text: tr(`${hash.slice(0, 7)} · 旧标签尚未定位`, `${hash.slice(0, 7)} · old label not located yet`)
      });
      const more = item.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": tr("管理无法定位的本地里程碑", "Manage local milestones that cannot be located") }
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
          ? tr("已读取最多 1000 条历史，仍无法定位这些旧标签。", "Read the maximum of 1000 commits and still cannot locate these old labels.")
          : this.history.hasMoreHistory
          ? tr("这些旧标签可能位于尚未读取的更早历史，仍缺少路径快照。", "These old labels may be in older history not read yet, and still lack a path snapshot.")
          : tr("当前分支或改写后的 Git 历史中没有足够信息定位这些旧标签。", "The current branch or rewritten Git history does not have enough information to locate these old labels.")
      });
      if (this.history.hasMoreHistory && !this.expandedMilestoneHistoryAttempted) {
        const expand = note.createEl("button", {
          text: this.expandingMilestoneHistory
            ? tr("正在读取…", "Reading…")
            : tr("临时读取更多历史", "Read more history for now")
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
      new Notice(tr(`读取更多历史失败：${errorMessage(error)}`, `Reading more history failed: ${errorMessage(error)}`), 8000);
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
    if (group.commits.length > 1) meta.createSpan({ text: tr(`${group.commits.length} 个 commit`, `${group.commits.length} commits`) });
    if (group.duplicateCount > 0) meta.createSpan({ text: tr(`${group.duplicateCount} 个重复`, `${group.duplicateCount} duplicates`) });
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
        attr: { "aria-label": this.expandedGroups.has(group.id) ? tr("收起原始提交", "Hide raw commits") : tr("展开原始提交", "Show raw commits") }
      });
      setIcon(expand, this.expandedGroups.has(group.id) ? "chevron-up" : "chevron-down");
      expand.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.expandedGroups.has(group.id)) this.expandedGroups.delete(group.id);
        else this.expandedGroups.add(group.id);
        this.render();
      });
    }
    const more = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tr("更多比较与版本操作", "More compare and version actions") } });
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
          member.createSpan({ cls: "git-note-history-duplicate-badge", text: tr("内容重复", "Duplicate content") });
        }
        if (this.contentSearchMatches.has(commit.hash)) {
          const scope = this.contentSearchMatches.get(commit.hash)?.scope;
          member.createSpan({
            cls: "git-note-history-content-match-badge",
            text: scope === "properties" ? tr("属性命中", "Property match") : tr("正文命中", "Text match")
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
      .setTitle(tr("查看跨文件编辑会话", "View cross-file editing session"))
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
      .setTitle(tr("创建只读时间胶囊", "Create read-only time capsule"))
      .setIcon("boxes")
      .onClick(() => this.confirmHistoricalSandbox(group.representative)));
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(tr("查看这组变化", "View these changes"))
      .setIcon("git-compare-arrows")
      .onClick(() => void this.openEffectiveGroupComparison(group, index, groups)));
    menu.addItem((item) => item
      .setTitle(tr("与当前工作区比较", "Compare with working copy"))
      .setIcon("file-diff")
      .onClick(() => void this.openAgainstWorking(group.representative)));
    const checkpointHash = state.reviewCheckpoint?.commitHash;
    const checkpoint = checkpointHash
      ? this.history.commits.find((commit) => commit.hash === checkpointHash)
      : undefined;
    if (checkpoint && checkpoint.hash !== group.representative.hash) {
      menu.addItem((item) => item
        .setTitle(tr("与上次复查点比较", "Compare with last review point"))
        .setIcon("inbox")
        .onClick(() => void this.openCommitPair(checkpoint, group.representative)));
    }
    this.addPreviousMilestoneCompareItems(menu, group.representative, state);
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(state.baselineHash === group.representative.hash ? tr("取消比较基线", "Clear compare baseline") : tr("设为比较基线", "Set as compare baseline"))
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
          ? tr(`已打开现有时间胶囊「${record.name}」。`, `Opened existing time capsule "${record.name}".`)
          : tr(`只读时间胶囊「${record.name}」已创建。`, `Read-only time capsule "${record.name}" created.`)
      );
    } catch (error) {
      new Notice(
        tr(`创建历史沙盒失败：${error instanceof Error ? error.message : String(error)}`, `Creating the historical sandbox failed: ${error instanceof Error ? error.message : String(error)}`),
        10000
      );
    }
  }

  private confirmHistoricalSandbox(commit: GitCommitVersion): void {
    new ConfirmActionModal(
      this.app,
      tr("创建整套历史 Vault 的只读时间胶囊？", "Create a read-only time capsule of the whole vault history?"),
      tr(`将从 ${commit.shortHash} 创建一个隔离 Git worktree，可能需要复制较多附件并占用磁盘空间。当前 Vault 不会 checkout；历史社区插件会被禁用。`, `An isolated Git worktree will be created from ${commit.shortHash}; this may copy many attachments and use disk space. The current vault is not checked out; historical community plugins are disabled.`),
      tr("创建时间胶囊", "Create time capsule"),
      () => this.createHistoricalSandbox(commit)
    ).open();
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "git-note-history-header" });
    const title = header.createDiv({ cls: "git-note-history-title-row" });
    const brand = title.createDiv({ cls: "git-note-history-brand" });
    setIcon(brand.createSpan(), "git-commit-horizontal");
    brand.createEl("h4", { text: tr("版本历史", "Version history") });

    const controls = title.createDiv({ cls: "git-note-history-header-actions" });
    if (this.targetFile && this.history) {
      const segment = controls.createDiv({ cls: "ap-seg git-note-history-scope", attr: { role: "group", "aria-label": tr("显示范围", "Range") } });
      const scopes: Array<[boolean, string]> = [[false, tr("全部", "All")], [true, tr("里程碑", "Milestones")]];
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
      attr: { "aria-label": tr("更多", "More"), "aria-haspopup": "menu", "aria-busy": String(this.loading) }
    });
    setIcon(more, this.loading ? "loader-circle" : "ellipsis");
    more.addEventListener("click", event => this.openMoreMenu(event, this.targetFile));

    if (this.targetFile) header.createDiv({ cls: "git-note-history-file-path", text: this.targetFile.path });
    this.renderPathHistory(header);

    const searchRow = header.createDiv({ cls: "git-note-history-search" });
    const search = new SearchComponent(searchRow);
    search.setPlaceholder(tr("搜索版本或历史内容", "Search versions or past content")).setValue(this.query).onChange((value) => {
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
        status.createSpan({ text: tr("输入至少 2 个字符后搜索历史内容；当前仅匹配版本信息。", "Type at least 2 characters to search past content; for now only version details match.") });
      } else if (this.contentSearchLoading) {
        status.createSpan({
          text: tr(`正在搜索历史内容 ${this.contentSearchScanned}/${this.contentSearchTotal} · 已命中 ${this.contentSearchMatches.size}`, `Searching past content ${this.contentSearchScanned}/${this.contentSearchTotal} · ${this.contentSearchMatches.size} matches`)
        });
      } else {
        const currentMatch = this.currentContentMatch();
        const failed = this.contentSearchFailed > 0 ? tr(` · ${this.contentSearchFailed} 个版本不可读`, ` · ${this.contentSearchFailed} versions unreadable`) : "";
        const working = currentMatch ? tr(" · 当前工作区命中", " · match in working copy") : "";
        status.createSpan({
          text: tr(`历史内容命中 ${this.contentSearchMatches.size} 个版本 · 已检查 ${this.contentSearchScanned}${working}${failed}`, `Past content matches in ${this.contentSearchMatches.size} versions · checked ${this.contentSearchScanned}${working}${failed}`)
        });
      }
    }
  }

  private openMoreMenu(event: MouseEvent, file: TFile | null): void {
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle(tr("跟随当前笔记", "Follow current note"))
      .setIcon("scan-eye")
      .setChecked(this.followActiveNote)
      .onClick(() => {
        this.followActiveNote = !this.followActiveNote;
        this.render();
      }));
    menu.addItem(item => item.setTitle(tr("刷新", "Refresh")).setIcon("refresh-cw").onClick(() => void this.refresh()));
    if (file && this.leaf.getRoot() !== this.app.workspace.rootSplit) {
      menu.addItem(item => item.setTitle(tr("在中央完整打开", "Open in the main area")).setIcon("panel-top-open").onClick(() => void this.plugin.activateHistoryInMain(file)));
    }
    if (!file) {
      menu.showAtMouseEvent(event);
      return;
    }
    menu.addSeparator();
    this.addReviewMenuItems(menu);
    if (this.history && this.timelineCommits().length > 0) {
      menu.addItem(item => item
        .setTitle(tr("笔记时光机", "Note time machine"))
        .setIcon("history")
        .setChecked(this.timeMachineExpanded)
        .onClick(() => {
          this.timeMachineExpanded = !this.timeMachineExpanded;
          if (!this.timeMachineExpanded) this.stopTimeMachinePlayback(false);
          this.render();
        }));
    }
    menu.addItem(item => item
      .setTitle(tr("显示原始提交", "Show raw commits"))
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
      .setTitle(basketCount > 0 ? tr(`恢复篮子（${basketCount}）`, `Recovery basket (${basketCount})`) : tr("恢复篮子", "Recovery basket"))
      .setIcon("shopping-basket")
      .onClick(() => void this.plugin.openRecoveryBasket(file)));
    menu.addSeparator();
    if (this.plugin.settings.showLabTools) {
      menu.addItem(item => item.setTitle(tr("追踪内容从哪一版变化", "Trace which version changed this content")).setIcon("scan-search").onClick(() => this.plugin.openKnowledgeTraceSetup(file)));
      menu.addItem(item => item.setTitle(tr("查看版本批注", "View version annotations")).setIcon("message-square-text").onClick(() => void this.plugin.openReviewAnnotations(file)));
      menu.addSeparator();
      menu.addItem(item => item.setTitle(tr("查看全部历史来源", "View all history sources")).setIcon("layers-3").onClick(() => void this.plugin.openHistorySources(file)));
      menu.addItem(item => item.setTitle(tr("来源与复查状态", "Sources and review state")).setIcon("scan-eye").onClick(() => void this.plugin.openProvenanceLens(file)));
      menu.addItem(item => item.setTitle(tr("知识图谱时间机", "Knowledge graph time machine")).setIcon("orbit").onClick(() => void this.plugin.openKnowledgeGraphTimeMachine(file)));
      menu.addSeparator();
      menu.addItem(item => item.setTitle(tr("历史健康检查", "History health check")).setIcon("activity").onClick(() => void this.plugin.openHistoryHealth(file)));
    }
    menu.addItem(item => item.setTitle(tr("看示例", "See example")).setIcon("presentation").onClick(() => new HistoryDemoModal(this.app, GIT_START_GUIDE_URL).open()));
    menu.addItem(item => item.setTitle(tr("恢复记录与撤销", "Restore records and undo")).setIcon("history").onClick(() => new RestoreHistoryModal(this.app, this.plugin).open()));
    menu.addItem(item => item.setTitle(tr("插件设置", "Plugin settings")).setIcon("settings").onClick(() => this.openSettings()));
    menu.showAtMouseEvent(event);
  }

  private renderPathHistory(container: HTMLElement): void {
    if (this.pathTransitions.length === 0) return;
    const disclosure = container.createEl("button", {
      cls: "git-note-history-path-disclosure",
      attr: {
        "aria-expanded": String(this.pathHistoryExpanded),
        "aria-label": tr(`${this.pathHistoryExpanded ? "收起" : "展开"}笔记路径轨迹`, `${this.pathHistoryExpanded ? "Collapse" : "Expand"} path history`)
      }
    });
    setIcon(disclosure.createSpan(), "folder-tree");
    disclosure.createSpan({ text: tr("路径轨迹", "Path history") });
    disclosure.createSpan({
      cls: "git-note-history-path-count",
      text: tr(`${this.pathTransitions.length} 次`, `${this.pathTransitions.length} times`)
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
          "aria-label": tr(`${transition.kind === "copy" ? "复制来源" : "重命名"}：${transition.fromPath} 到 ${transition.toPath}`, `${transition.kind === "copy" ? "Copied from" : "Renamed"}: ${transition.fromPath} to ${transition.toPath}`)
        }
      });
      const meta = item.createDiv({ cls: "git-note-history-path-event-meta" });
      meta.createSpan({
        cls: `git-note-history-path-kind is-${transition.kind}`,
        text: transition.kind === "copy" ? tr("复制来源", "Copied from") : tr("重命名", "Renamed")
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
      text: transition.kind === "copy" ? tr("复制来源", "Copied from") : tr("路径变更", "Path change")
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
    title.createSpan({ text: tr("当前工作区", "Working copy") });
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
      const review = actions.createEl("button", { text: baseline ? tr("与基线比较", "Compare with baseline") : tr("查看当前改动", "View current edits") });
      review.addEventListener("click", () => void this.openAgainstWorking(defaultBase));
    }
    const latestMilestone = previousNamedMilestone(this.history.commits, state);
    if (latestMilestone && latestMilestone.commit.hash !== defaultBase?.hash) {
      const compareMilestone = actions.createEl("button", { text: tr("与最近里程碑比较", "Compare with latest milestone") });
      compareMilestone.addEventListener("click", () => void this.openAgainstWorking(latestMilestone.commit));
    }
    const event = actions.createEl("button", { text: tr("查看本次工作", "View this work") });
    event.addEventListener("click", () => void this.plugin.openWorkEvent({
      repositoryRoot: this.history!.context.repositoryRoot,
      anchorVaultPath: this.targetFile!.path,
      source: { kind: "working" }
    }));
    const workspace = actions.createEl("button", { text: tr("未提交笔记", "Uncommitted note") });
    workspace.addEventListener("click", () => void this.plugin.activateWorkspaceReview());
    if (this.history.status.conflicted) {
      const resolve = actions.createEl("button", { cls: "mod-warning", text: tr("解决冲突", "Resolve conflict") });
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
        text: tr(`比较基线：${baseline.shortHash} ${baselineMilestone?.label ?? baseline.subject}`, `Compare baseline: ${baseline.shortHash} ${baselineMilestone?.label ?? baseline.subject}`)
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
        "aria-label": this.timeMachineExpanded ? tr("收起时光机", "Hide time machine") : tr("展开时光机", "Show time machine")
      }
    });
    setIcon(heading.createSpan(), this.timeMachineExpanded ? "chevron-down" : "chevron-right");
    heading.createSpan({ text: tr("笔记时光机", "Note time machine") });
    heading.createSpan({
      cls: "git-note-history-time-machine-count",
      text: tr(`${chronological.length} 个${this.showRawCommits ? "提交" : "有效版本"}`, `${chronological.length} ${this.showRawCommits ? "commits" : "effective versions"}`)
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
        "aria-label": this.playbackTimer !== null ? tr("暂停版本播放", "Pause playback") : tr("从旧到新播放版本", "Play versions from old to new"),
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
        : tr("当前工作区", "Working copy")
    });
    const dateLabel = labelRow.createSpan({
      cls: "git-note-history-time-machine-date",
      text: selected ? formatCommitTime(selected.authoredAt, true) : tr("现在", "Now")
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
        "aria-label": tr("选择要浏览的笔记版本", "Choose a note version to view")
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
    marks.createEl("option", { attr: { value: String(max), label: tr("现在", "Now") } });

    const updateLabels = () => {
      const position = Number.parseInt(slider.value, 10);
      this.timeMachinePosition = Number.isFinite(position) ? position : max;
      const commit = chronological[this.timeMachinePosition];
      versionLabel.setText(
        commit ? `${commit.shortHash} · ${this.commitDisplayLabel(commit, state)}` : tr("当前工作区", "Working copy")
      );
      dateLabel.setText(commit ? formatCommitTime(commit.authoredAt, true) : tr("现在", "Now"));
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
    footer.createSpan({ text: tr("最早", "Earliest") });
    const open = footer.createEl("button");
    setIcon(open.createSpan(), "panel-top-open");
    open.createSpan({ text: tr("查看此刻", "View this moment") });
    open.addEventListener("click", () => void this.openTimeMachinePosition());
    footer.createSpan({ text: tr("现在", "Now") });
  }

  private commitDisplayLabel(commit: GitCommitVersion, state: FileReviewState): string {
    return milestonesForCommit(
      state,
      commit.hash,
      { includeReviewCheckpoint: false }
    )[0]?.label ?? (commit.subject || tr("无提交说明", "No commit message"));
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
        target: { kind: "working", label: tr("当前工作区", "Working copy") },
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
    bar.createSpan({ text: tr(`已选 ${this.compareSelection.size}/2 个版本`, `${this.compareSelection.size}/2 versions selected`) });
    const clear = bar.createEl("button", { text: tr("清除", "Clear") });
    clear.addEventListener("click", () => {
      this.compareSelection.clear();
      this.render();
    });
    if (this.compareSelection.size === 2) {
      const compare = bar.createEl("button", { cls: "mod-cta", text: tr("比较两个版本", "Compare two versions") });
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
      text: commit.subject || tr("（无提交说明）", "(no commit message)")
    });
    trigger.addEventListener("focus", () => this.selectRow(row, filteredIndex));
    const rail = row.createDiv({ cls: "git-note-history-rail" });
    const dot = rail.createSpan({ cls: `git-note-history-dot change-${commit.changeType.toLowerCase()}` });
    setIcon(dot, commit.changeType === "R" ? "file-symlink" : commit.changeType === "C" ? "copy" : "git-commit-horizontal");

    const content = row.createDiv({ cls: "git-note-history-commit-content" });
    const top = content.createDiv({ cls: "git-note-history-commit-top" });
    top.createSpan({ cls: "git-note-history-commit-subject", text: commit.subject || tr("（无提交说明）", "(no commit message)") });
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
    if (state.baselineHash === commit.hash) this.addBadge(badges, "star", tr("比较基线", "Compare baseline"), "is-baseline");
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
      attr: { "aria-label": tr("选择用于双版本比较", "Select for two-version compare"), "aria-pressed": String(this.compareSelection.has(commit.hash)) }
    });
    setIcon(select, "square-stack");
    select.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleCompare(commit.hash);
    });

    const more = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tr("更多操作", "More actions") } });
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
    row.createDiv({ cls: "git-note-history-hover-preview", text: preview || tr("（空版本）", "(empty version)") });
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
      tr(`事件时间 ${eventTime}`, `Event time ${eventTime}`),
      milestone.note ?? ""
    ].filter(Boolean).join(" · ");
    const badge = commit
      ? container.createEl("button", {
          cls: `git-note-history-badge git-note-history-milestone-badge is-${kind}`,
          attr: {
            type: "button",
            title: tooltip,
            "aria-label": tr(`编辑里程碑「${milestone.label}」，事件时间 ${eventTime}`, `Edit milestone "${milestone.label}", event time ${eventTime}`)
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
        new Notice(milestone ? tr(`已命名为「${milestone.label}」。`, `Named "${milestone.label}".`) : tr("已移除里程碑。", "Milestone removed."));
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
        .setTitle(tr(`编辑里程碑「${milestone.label}」`, `Edit milestone "${milestone.label}"`))
        .setIcon(milestoneKindIcon(milestone.kind))
        .onClick(() => this.openMilestoneEditor(commit, milestone)));
    }
    menu.addItem((item) => item
      .setTitle(milestones.length > 0 ? tr("再添加一个里程碑", "Add another milestone") : tr("命名这个版本", "Name this version"))
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
      sent: tr("与上次发送版比较", "Compare with last sent version"),
      submitted: tr("与上次材料提交版比较", "Compare with last submitted version"),
      confirmed: tr("与上次确认版比较", "Compare with last confirmed version"),
      exported: tr("与上次导出版比较", "Compare with last exported version"),
      "important-draft": tr("与上个重要草稿比较", "Compare with last important draft"),
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
        .setTitle(titles[kind] || tr(`与上个里程碑「${previous.milestone.label}」比较`, `Compare with previous milestone "${previous.milestone.label}"`))
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
      text: contentMatch.scope === "properties" ? tr("属性", "Properties") : tr("正文", "Text")
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
      .setTitle(tr("查看本次工作事件", "View this work event"))
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
      .setTitle(tr("创建只读时间胶囊", "Create read-only time capsule"))
      .setIcon("boxes")
      .onClick(() => this.confirmHistoricalSandbox(commit)));
    if (this.targetFile) {
      menu.addItem((item) => item
        .setTitle(tr("批注这个历史版本", "Annotate this version"))
        .setIcon("message-square-plus")
        .onClick(() => void this.plugin.addCommitReviewAnnotation(this.targetFile!, commit)));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(tr("与当前版本比较", "Compare with current version")).setIcon("git-compare-arrows").onClick(() => void this.openAgainstWorking(commit)));
    this.addPreviousMilestoneCompareItems(menu, commit, state);
    menu.addItem((item) => item.setTitle(state.baselineHash === commit.hash ? tr("取消比较基线", "Clear compare baseline") : tr("设为比较基线", "Set as compare baseline")).setIcon("star").onClick(async () => {
      await this.plugin.setBaseline(this.history!.context, state.baselineHash === commit.hash ? null : commit);
      this.render();
    }));
    this.addMilestoneMenuItems(menu, commit, state);
    if (this.targetFile) {
      const file = this.targetFile;
      menu.addItem((item) => item.setTitle(tr("复制版本链接", "Copy version link")).setIcon("link").onClick(() => void this.plugin.copyVersionLink(file, commit)));
    }
    menu.addItem((item) => item.setTitle(tr("复制完整 commit hash", "Copy full commit hash")).setIcon("copy").onClick(async () => {
      await navigator.clipboard.writeText(commit.hash);
      new Notice(tr("已复制 commit hash。", "Commit hash copied."));
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
      target: { kind: "working", label: tr("当前工作区", "Working copy") },
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
    status.createSpan({ text: tr("正在读取 Git 历史…", "Reading Git history…") });
    // 停止只是不再等这次结果；Git 本身只读，超时后会自己结束
    const stop = status.createEl("button", { cls: "mod-muted", text: tr("停止", "Stop") });
    stop.addEventListener("click", () => {
      this.refreshGeneration += 1;
      this.loading = false;
      this.history = null;
      this.error = tr("已停止读取。", "Reading was stopped.");
      this.errorProblem = "stopped";
      this.render();
    });
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
    const summary = hasHiddenRows ? tr(`已显示 ${visible} / ${total}`, `Showing ${visible} of ${total}`) : tr(`已显示 ${visible} 个版本`, `Showing ${visible} versions`);
    footer.createSpan({ text: this.history.hasMoreHistory ? tr(`${summary} · 已达读取上限`, `${summary} · read limit reached`) : summary });
    if (hasHiddenRows) {
      const nextCount = Math.min(DEFAULT_TIMELINE_BATCH_SIZE, total - visible);
      const more = footer.createEl("button", { text: tr(`再显示 ${nextCount} 个`, `Show ${nextCount} more`) });
      more.addEventListener("click", () => {
        this.visibleTimelineCount = expandTimelineLimit(this.visibleTimelineCount, total);
        this.render();
      });
    }
  }

  private openSettings(): void {
    const settings = (this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } }).setting;
    settings?.open();
    settings?.openTabById(this.plugin.manifest.id);
  }

  /**
   * Git could not be read. Each case gets one next step, and every step only reads or explains:
   * the plugin never creates a repository or a commit for the user.
   */
  private renderGitProblem(container: HTMLElement): void {
    const demo = (): void => new HistoryDemoModal(this.app, GIT_START_GUIDE_URL).open();
    const reload = (): void => void this.refresh();
    const settings = (): void => this.openSettings();
    switch (this.errorProblem) {
      case "not-repo":
        this.renderState(container, "folder-git-2", tr("这个库还没有 Git 历史", "This vault has no Git history yet"),
          tr("Git Note History 只读取已有的 Git 历史，不会替你建仓库或提交。仓库在别的文件夹时，可以在设置里填写仓库位置。先看一个示例，了解它能做什么。",
            "Git Note History only reads existing Git history; it never creates a repository or commits for you. If the repository lives in another folder, set its location in settings. See an example of what it does first."),
          tr("看示例", "See example"), demo);
        return;
      case "no-git":
        this.renderState(container, "terminal", tr("找不到 Git", "Git was not found"),
          tr("需要先在电脑上安装 Git。装在不常见的位置时，在设置里填写 Git 程序的路径。", "Install Git on this computer first. If it is in an unusual place, enter its path in settings."),
          tr("打开设置", "Open settings"), settings, this.error);
        return;
      case "outside-repo":
        this.renderState(container, "folder-x", tr("这篇笔记不在仓库里", "This note is outside the repository"),
          tr("检测到的仓库不包含这篇笔记。仓库位置不对时，可以在设置里修改。", "The detected repository does not contain this note. If the location is wrong, change it in settings."),
          tr("打开设置", "Open settings"), settings);
        return;
      case "not-desktop":
        this.renderState(container, "monitor", tr("只能在电脑上用", "Desktop only"),
          tr("版本历史来自电脑上的 Git，手机版 Obsidian 读不到。", "History comes from Git on your computer; Obsidian on a phone cannot read it."));
        return;
      case "stopped":
        this.renderState(container, "circle-pause", tr("已停止读取", "Reading stopped"),
          tr("没有读到任何内容，也没有改动仓库。", "Nothing was read and the repository was not changed."), tr("重新读取", "Read again"), reload);
        return;
      default:
        this.renderState(container, "triangle-alert", tr("无法读取版本历史", "Could not read the history"),
          this.errorProblem === "timeout" ? tr("Git 太久没有回应。仓库很大时，可以在设置里调小最多读取的提交数。", "Git took too long. For a large repository, lower the maximum number of commits in settings.") : tr("下面是 Git 的原始提示。", "Git's own message is below."),
          tr("重新加载", "Reload"), reload, this.error);
    }
  }

  private renderEmptyHistory(container: HTMLElement): void {
    const reload = (): void => void this.refresh();
    const history = this.history;
    switch (history?.emptyReason) {
      case "no-commits":
        this.renderState(container, "git-commit-horizontal", tr("仓库里还没有提交", "The repository has no commits yet"),
          tr("在终端或你平常用的 Git 工具里做第一次提交后，版本会出现在这里。本插件不会替你提交。先看一个示例，了解它能做什么。", "Make the first commit in a terminal or your usual Git tool and versions will appear here. This plugin never commits for you. See an example of what it does first."),
          tr("看示例", "See example"), () => new HistoryDemoModal(this.app, GIT_START_GUIDE_URL).open());
        return;
      case "untracked":
        this.renderState(container, "file-plus", tr("这篇笔记还没被 Git 跟踪", "Git is not tracking this note yet"),
          tr("它还没有进过任何提交。用你平常的 Git 工具提交后，这里会出现第一个版本。", "It has never been committed. After you commit it with your usual Git tool, the first version appears here."),
          tr("刷新", "Refresh"), reload);
        return;
      case "ignored":
        this.renderState(container, "eye-off", tr("这篇笔记被 Git 忽略了", "Git ignores this note"),
          tr(`忽略规则 ${history.ignoreRule || ".gitignore"} 排除了它，所以不会有历史。要保留历史，需要改这条规则。`, `The ignore rule ${history.ignoreRule || ".gitignore"} excludes it, so it has no history. Change that rule to keep its history.`),
          tr("刷新", "Refresh"), reload);
        return;
      case "staged":
        this.renderState(container, "git-commit-horizontal", tr("已暂存，还没提交", "Staged but not committed"),
          tr("提交以后，这里会出现第一个版本。", "Once you commit, the first version appears here."), tr("刷新", "Refresh"), reload);
        return;
      default:
        this.renderState(container, "git-commit-horizontal", tr("这篇没有提交过的版本", "No committed versions of this note"),
          tr("Git 跟踪着它，但找不到包含它的提交。可能是改名前的历史超出了读取范围，可以在设置里调大最多读取的提交数。", "Git tracks it but no commit contains it. History from before a rename may be out of range; raise the maximum number of commits in settings."),
          tr("刷新", "Refresh"), reload);
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
