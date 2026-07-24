import {
  ItemView,
  Menu,
  Notice,
  SearchComponent,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type {
  DetailMode,
  EffectiveVersionGroup,
  FileReviewState,
  GitCommitVersion,
  GitFileHistory
} from "../models";
import { GitCommandError } from "../git/git-client";
import { VersionLabelModal } from "../ui/label-modal";
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

function statusLabel(history: GitFileHistory): string {
  const { status } = history;
  if (status.conflicted) return "存在冲突";
  if (status.untracked) return "尚未跟踪";
  if (status.staged && status.unstaged) return "已暂存 + 未暂存";
  if (status.staged) return "已暂存";
  if (status.unstaged) return "未提交修改";
  return "工作区干净";
}

function matchesSearch(commit: GitCommitVersion, query: string, state: FileReviewState): boolean {
  if (!query) return true;
  const bookmark = state.bookmarks[commit.hash]?.label ?? "";
  const trailers = Object.values(commit.trailers).join(" ");
  return [commit.subject, commit.authorName, commit.authorEmail, commit.hash, commit.authoredAt, bookmark, trailers]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase());
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
  private readonly expandedGroups = new Set<string>();
  private showRawCommits = false;
  private currentFingerprint = "";
  private refiningGroups = false;
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
    this.registerDomEvent(this.contentEl, "keydown", (event) => this.handleKeyboard(event));
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
        const previousContext = this.history?.context;
        this.targetFile = file;
        void (async () => {
          if (previousContext) {
            const nextContext = await this.plugin.gitClient.resolveFileContext(file);
            await this.plugin.migrateFileReviewState(previousContext, nextContext);
          }
          await this.refresh();
        })();
      }
    }));

    const active = this.app.workspace.getActiveFile();
    if (active?.extension === "md") await this.setFile(active);
    else this.render();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.stopTimeMachinePlayback(false);
    if (this.timeMachinePreviewTimer !== null) window.clearTimeout(this.timeMachinePreviewTimer);
  }

  async setFile(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    this.stopTimeMachinePlayback(false);
    this.targetFile = file;
    this.history = null;
    this.compareSelection.clear();
    this.commitContents.clear();
    this.effectiveGroups = [];
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
      this.history = history;
      this.currentFingerprint = contentFingerprint(currentContent);
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
    container.addClass("git-note-history-view");
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
    const overview = container.createDiv({ cls: "git-note-history-overview" });
    this.renderReviewInbox(overview, state);
    this.renderWorkingTreeCard(overview, state);
    this.renderTimeMachine(container);
    this.renderCompareBar(container);

    this.renderVersionModeToggle(container);

    const commits = this.history.commits.filter((commit) => matchesSearch(commit, this.query, state));
    if (commits.length === 0) {
      if (this.query) {
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
      return;
    }

    const groups = this.effectiveGroups.filter((group) =>
      group.commits.some((commit) => matchesSearch(commit, this.query, state))
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
  }

  private timelineCommits(): GitCommitVersion[] {
    return this.showRawCommits
      ? (this.history?.commits ?? [])
      : this.effectiveGroups.map((group) => group.representative);
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

  private renderReviewInbox(container: HTMLElement, state: FileReviewState): void {
    if (!this.history || !this.targetFile) return;
    const latest = this.history.commits[0];
    if (!latest) return;
    const checkpoint = state.reviewCheckpoint;
    const card = container.createDiv({ cls: "git-note-history-review-inbox" });
    const heading = card.createDiv({ cls: "git-note-history-review-inbox-heading" });
    const icon = heading.createSpan();
    setIcon(icon, checkpoint ? "inbox" : "circle-dot-dashed");
    const title = heading.createDiv();
    title.createEl("strong", { text: checkpoint ? "待复查" : "建立复查起点" });

    if (!checkpoint) {
      title.createDiv({ text: "设一个起点，以后只看新增变化。" });
      const actions = card.createDiv({ cls: "git-note-history-review-inbox-actions" });
      const hasWorkingChanges = this.history.status.staged
        || this.history.status.unstaged
        || this.history.status.untracked;
      if (hasWorkingChanges) {
        const review = actions.createEl("button", { text: "查看改动" });
        review.addEventListener("click", () => void this.openAgainstWorking(latest));
      }
      const mark = actions.createEl("button", { cls: "mod-cta", text: "设为复查起点" });
      mark.addEventListener("click", () => void this.markCurrentReviewed(latest));
      return;
    }

    const pendingGroups = groupsSinceCheckpoint(this.effectiveGroups, checkpoint.commitHash);
    const workingChanged = checkpoint.workingFingerprint
      ? checkpoint.workingFingerprint !== this.currentFingerprint
      : this.history.status.staged || this.history.status.unstaged || this.history.status.untracked;
    const pendingStats = pendingGroups.reduce(
      (total, group) => ({
        added: total.added + group.addedLines,
        deleted: total.deleted + group.deletedLines
      }),
      { added: this.history.workingTreeStats.addedLines, deleted: this.history.workingTreeStats.deletedLines }
    );
    const checkpointDate = formatCommitTime(checkpoint.reviewedAt, true);
    if (pendingGroups.length === 0 && !workingChanged) {
      card.addClass("is-reviewed");
      title.createDiv({ text: `已复查到 ${checkpointDate}，目前没有新变化。` });
      const clear = heading.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "清除复查点" } });
      setIcon(clear, "x");
      clear.addEventListener("click", async () => {
        await this.plugin.clearReviewCheckpoint(this.history!.context);
        this.render();
      });
      return;
    }

    title.createDiv({
      text: `自 ${checkpointDate}：${pendingGroups.length} 个有效版本${workingChanged ? "，含当前工作区" : ""}`
    });
    const metrics = card.createDiv({ cls: "git-note-history-review-inbox-metrics" });
    metrics.createSpan({ cls: "is-added", text: `+${pendingStats.added}` });
    metrics.createSpan({ cls: "is-removed", text: `−${pendingStats.deleted}` });
    const folded = pendingGroups.reduce((count, group) => count + Math.max(0, group.commits.length - 1), 0);
    if (folded > 0) metrics.createSpan({ text: `已折叠 ${folded} 次备份` });

    const actions = card.createDiv({ cls: "git-note-history-review-inbox-actions" });
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
    const review = actions.createEl("button", { cls: "mod-cta", text: "审阅这些变化" });
    review.addEventListener("click", () => void this.openAgainstWorking(checkpointCommit));
    const mark = actions.createEl("button", { text: "标记已复查" });
    mark.addEventListener("click", () => void this.markCurrentReviewed(latest));
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

  private renderVersionModeToggle(container: HTMLElement): void {
    if (!this.history || this.history.commits.length === 0) return;
    const bar = container.createDiv({ cls: "git-note-history-version-mode" });
    const label = bar.createDiv();
    label.createEl("strong", { text: this.showRawCommits ? "原始提交" : "版本" });
    label.createSpan({
      text: this.showRawCommits
        ? ` ${this.history.commits.length} 条`
        : ` ${this.effectiveGroups.length} 组${this.refiningGroups ? " · 正在识别重复内容…" : ""}`
    });
    const toggle = bar.createEl("button", {
      text: this.showRawCommits ? "显示有效版本" : "显示原始提交",
      attr: { "aria-pressed": String(this.showRawCommits) }
    });
    toggle.addEventListener("click", () => {
      this.showRawCommits = !this.showRawCommits;
      this.timeMachinePosition = this.timelineCommits().length;
      this.selectedIndex = 0;
      this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
      this.render();
    });
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
      cls: `git-note-history-commit git-note-history-effective-group ${index === this.selectedIndex ? "is-keyboard-selected" : ""}`,
      attr: { tabindex: "0", role: "button", "aria-label": `${group.summary}, ${formatCommitTime(representative.authoredAt, true)}` }
    });
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

    const actions = row.createDiv({ cls: "git-note-history-row-actions" });
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
    row.addEventListener("click", () => void this.openEffectiveGroupComparison(group, index, visibleGroups));

    if (this.expandedGroups.has(group.id)) {
      const members = container.createDiv({ cls: "git-note-history-effective-members" });
      group.commits.forEach((commit, memberIndex) => {
        const member = members.createEl("button", { cls: "git-note-history-effective-member" });
        member.createSpan({ text: commit.subject || commit.shortHash });
        member.createSpan({ text: `${formatCommitTime(commit.authoredAt)} · ${commit.shortHash}` });
        if (memberIndex > 0 && this.commitContents.get(commit.hash) === this.commitContents.get(group.commits[memberIndex - 1]!.hash)) {
          member.createSpan({ cls: "git-note-history-duplicate-badge", text: "内容重复" });
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

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "git-note-history-header" });
    const title = header.createDiv({ cls: "git-note-history-title-row" });
    const brand = title.createDiv({ cls: "git-note-history-brand" });
    setIcon(brand.createSpan(), "git-commit-horizontal");
    brand.createEl("h4", { text: "版本历史" });

    const controls = title.createDiv({ cls: "git-note-history-header-actions" });
    const follow = controls.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": this.followActiveNote ? "正在跟随当前笔记；点击固定" : "已固定笔记；点击重新跟随",
        "aria-pressed": String(this.followActiveNote)
      }
    });
    setIcon(follow, this.followActiveNote ? "scan-eye" : "pin");
    follow.addEventListener("click", () => {
      this.followActiveNote = !this.followActiveNote;
      this.render();
    });

    const refresh = controls.createEl("button", {
      cls: this.loading ? "clickable-icon is-loading" : "clickable-icon",
      attr: { "aria-label": this.loading ? "正在刷新" : "刷新", "aria-busy": String(this.loading) }
    });
    refresh.disabled = this.loading;
    setIcon(refresh, this.loading ? "loader-circle" : "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());

    if (this.targetFile && this.leaf.getRoot() !== this.app.workspace.rootSplit) {
      const openMain = controls.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "在中央完整打开" }
      });
      setIcon(openMain, "panel-top-open");
      openMain.addEventListener("click", () => void this.plugin.activateHistoryInMain(this.targetFile));
    }

    if (this.targetFile) header.createDiv({ cls: "git-note-history-file-path", text: this.targetFile.path });

    const searchRow = header.createDiv({ cls: "git-note-history-search" });
    const search = new SearchComponent(searchRow);
    search.setPlaceholder("搜索版本").setValue(this.query).onChange((value) => {
      this.query = value.trim();
      this.selectedIndex = 0;
      this.visibleTimelineCount = DEFAULT_TIMELINE_BATCH_SIZE;
      this.render();
    });
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
      ? this.history.commits.find((commit) => commit.hash === state.baselineHash)
      : undefined;
    const defaultBase = baseline ?? this.history.commits[0];
    if (defaultBase) {
      const review = actions.createEl("button", { text: baseline ? "与基线比较" : "查看当前改动" });
      review.addEventListener("click", () => void this.openAgainstWorking(defaultBase));
    }
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
      baselineRow.createSpan({ text: `比较基线：${baseline.shortHash} ${state.bookmarks[baseline.hash]?.label ?? baseline.subject}` });
    }
  }

  private renderTimeMachine(container: HTMLElement): void {
    if (!this.history || !this.targetFile || this.timelineCommits().length === 0) return;
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
      text: selected ? `${selected.shortHash} · ${selected.subject || "无提交说明"}` : "当前工作区"
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
      if (index === 0 || commit.changeType === "R" || commit.addedLines + commit.deletedLines >= 20) {
        marks.createEl("option", { attr: { value: String(index), label: commit.shortHash } });
      }
    });
    marks.createEl("option", { attr: { value: String(max), label: "现在" } });

    const updateLabels = () => {
      const position = Number.parseInt(slider.value, 10);
      this.timeMachinePosition = Number.isFinite(position) ? position : max;
      const commit = chronological[this.timeMachinePosition];
      versionLabel.setText(commit ? `${commit.shortHash} · ${commit.subject || "无提交说明"}` : "当前工作区");
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
      cls: `git-note-history-commit ${filteredIndex === this.selectedIndex ? "is-keyboard-selected" : ""}`,
      attr: { tabindex: "0", role: "button", "aria-label": `${commit.subject}, ${formatCommitTime(commit.authoredAt, true)}` }
    });
    const rail = row.createDiv({ cls: "git-note-history-rail" });
    const dot = rail.createSpan({ cls: `git-note-history-dot change-${commit.changeType.toLowerCase()}` });
    setIcon(dot, commit.changeType === "R" ? "file-symlink" : "git-commit-horizontal");

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

    const badges = content.createDiv({ cls: "git-note-history-badges" });
    if (state.baselineHash === commit.hash) this.addBadge(badges, "star", "比较基线", "is-baseline");
    const bookmark = state.bookmarks[commit.hash];
    if (bookmark) this.addBadge(badges, "bookmark", bookmark.label, "is-bookmark");
    for (const [key, value] of Object.entries(commit.trailers)) {
      this.addBadge(badges, key === "agent" ? "bot" : "shield-check", value, `is-${key}`);
    }

    const actions = row.createDiv({ cls: "git-note-history-row-actions" });
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

    row.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey) this.toggleCompare(commit.hash);
      else void this.openAgainstWorking(commit);
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

  private openCommitMenu(event: MouseEvent, commit: GitCommitVersion, state: FileReviewState): void {
    if (!this.history) return;
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("与当前版本比较").setIcon("git-compare-arrows").onClick(() => void this.openAgainstWorking(commit)));
    menu.addItem((item) => item.setTitle(state.baselineHash === commit.hash ? "取消比较基线" : "设为比较基线").setIcon("star").onClick(async () => {
      await this.plugin.setBaseline(this.history!.context, state.baselineHash === commit.hash ? null : commit);
      this.render();
    }));
    menu.addItem((item) => item.setTitle("设置版本标签").setIcon("bookmark").onClick(() => {
      new VersionLabelModal(this.app, state.bookmarks[commit.hash]?.label ?? "", async (label) => {
        await this.plugin.setVersionLabel(this.history!.context, commit.hash, label);
        this.render();
      }).open();
    }));
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
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || !this.history) return;
    const state = this.plugin.getFileReviewState(this.history.context);
    const filtered = (this.showRawCommits
      ? this.history.commits
      : this.effectiveGroups.map((group) => group.representative))
      .filter((commit) => matchesSearch(commit, this.query, state));
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
    } else if (["Enter", "d", "p"].includes(event.key.toLowerCase())) {
      const commit = filtered[this.selectedIndex];
      if (!commit) return;
      event.preventDefault();
      void this.openAgainstWorking(commit, event.key.toLowerCase() === "p" ? "preview" : undefined);
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
