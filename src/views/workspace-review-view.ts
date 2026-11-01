import {
  ItemView,
  Menu,
  Notice,
  SearchComponent,
  WorkspaceLeaf,
  normalizePath,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type {
  GitCommitVersion,
  GitRepositoryContext,
  ReviewInboxItem,
  ReviewInboxSnapshot
} from "../models";
import { contentFingerprint } from "../history/version-groups";
import { ConfirmActionModal } from "../ui/confirm-modal";
import {
  groupReviewInboxItems,
  reviewInboxItemMatchesFilter,
  reviewInboxPendingStatus,
  type ReviewInboxFilter
} from "../review/review-inbox";
import { workspaceNoteLabel } from "../workspace/change-presentation";
import { tr } from "../i18n";

export const GIT_WORKSPACE_REVIEW_VIEW_TYPE = "git-workspace-review-view";

interface PendingInboxItem {
  item: ReviewInboxItem;
  workingFingerprint?: string;
  snoozed: boolean;
}

const FILTER_LABELS: Record<ReviewInboxFilter, string> = {
  pending: tr("待复查", "To review"),
  committed: tr("已提交", "Committed"),
  working: tr("未提交", "Uncommitted"),
  snoozed: tr("稍后", "Later")
};

export class GitWorkspaceReviewView extends ItemView {
  private snapshot: ReviewInboxSnapshot | null = null;
  private pendingItems: PendingInboxItem[] = [];
  private loading = false;
  private error = "";
  private query = "";
  private filter: ReviewInboxFilter = "pending";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GitNoteHistoryPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_WORKSPACE_REVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return tr("复查收件箱", "Review inbox");
  }

  getIcon(): string {
    return "list-checks";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const context = await this.plugin.gitClient.resolveRepositoryContext();
      const checkpoint = this.plugin.getReviewInboxCheckpoint(context.repositoryRoot);
      this.snapshot = await this.plugin.gitClient.loadReviewInbox(
        checkpoint?.commitHash,
        [...this.plugin.settings.reviewExcludedPaths, this.app.vault.configDir]
      );
      this.pendingItems = await this.buildPendingItems(this.snapshot);
    } catch (error) {
      this.snapshot = null;
      this.pendingItems = [];
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async buildPendingItems(snapshot: ReviewInboxSnapshot): Promise<PendingInboxItem[]> {
    const pending: PendingInboxItem[] = [];
    for (const source of snapshot.items) {
      const context = this.itemContext(snapshot, source);
      const state = this.plugin.getFileReviewState(context);
      let workingFingerprint: string | undefined;

      if (source.workspaceChange) {
        const file = this.app.vault.getFileByPath(source.vaultPath);
        if (file) {
          workingFingerprint = contentFingerprint(await this.app.vault.read(file));
        } else {
          const change = source.workspaceChange;
          workingFingerprint = contentFingerprint(
            `missing:${change.indexStatus}${change.workTreeStatus}:${source.vaultPath}`
          );
        }
      }

      const { committedPending, workingPending, snoozed } = reviewInboxPendingStatus(
        source,
        state,
        snapshot.headHash,
        workingFingerprint
      );
      if (!committedPending && !workingPending) continue;
      const item: ReviewInboxItem = { ...source };
      if (!committedPending) {
        delete item.committedChange;
        delete item.latestCommit;
      }
      if (!workingPending) delete item.workspaceChange;
      const stats = [item.committedChange, item.workspaceChange].filter(Boolean);
      item.addedLines = stats.reduce((sum, change) => sum + (change?.addedLines ?? 0), 0);
      item.deletedLines = stats.reduce((sum, change) => sum + (change?.deletedLines ?? 0), 0);
      pending.push({ item, ...(workingFingerprint ? { workingFingerprint } : {}), snoozed });
    }
    return pending;
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "git-workspace-review-view", "git-review-inbox-view");
    container.toggleClass("is-compact", this.plugin.settings.density === "compact");

    const header = container.createDiv({ cls: "git-review-inbox-header" });
    const heading = header.createDiv({ cls: "git-review-inbox-title" });
    const headingIcon = heading.createSpan();
    setIcon(headingIcon, "inbox");
    const headingText = heading.createDiv();
    headingText.createEl("h4", { text: tr("复查收件箱", "Review inbox") });
    headingText.createSpan({ text: tr("集中处理自上次确认后的笔记变化", "Note changes since you last confirmed, in one place") });

    const headerActions = header.createDiv({ cls: "git-review-inbox-header-actions" });
    const refresh = headerActions.createEl("button", {
      cls: this.loading ? "clickable-icon is-loading" : "clickable-icon",
      attr: {
        "aria-label": this.loading ? tr("正在刷新复查收件箱", "Refreshing the review inbox") : tr("刷新复查收件箱", "Refresh the review inbox"),
        "aria-busy": String(this.loading)
      }
    });
    refresh.disabled = this.loading;
    setIcon(refresh, this.loading ? "loader-circle" : "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());

    if (this.loading) {
      const loading = container.createDiv({
        cls: "git-workspace-review-loading",
        attr: { role: "status", "aria-live": "polite" }
      });
      const icon = loading.createSpan();
      setIcon(icon, "loader-circle");
      loading.createSpan({ text: tr("正在汇总已提交与未提交变化…", "Gathering committed and uncommitted changes…") });
      return;
    }
    if (this.error) {
      container.createEl("pre", { cls: "git-note-history-error", text: this.error });
      return;
    }
    if (!this.snapshot) return;

    this.renderStartingPoint(container);
    this.renderSummary(container);
    this.renderControls(container);
    this.renderItems(container);
  }

  private renderStartingPoint(container: HTMLElement): void {
    if (!this.snapshot) return;
    const checkpoint = this.plugin.getReviewInboxCheckpoint(this.snapshot.context.repositoryRoot);
    if (checkpoint && this.snapshot.baselineValid) return;

    const notice = container.createDiv({
      cls: `git-review-inbox-start ${checkpoint ? "is-warning" : ""}`
    });
    const icon = notice.createSpan();
    setIcon(icon, checkpoint ? "triangle-alert" : "flag");
    const copy = notice.createDiv();
    copy.createEl("strong", { text: checkpoint ? tr("原复查起点已不可用", "The old review starting point is gone") : tr("先建立全库复查起点", "Set a starting point for the whole vault") });
    copy.createSpan({
      text: checkpoint
        ? tr("可能发生过历史重写；重新从当前提交开始，不会修改 Git。", "History may have been rewritten. Start again from the current commit; Git is not changed.")
        : tr("以后进入 Git 的笔记变化会自动出现在这里，当前未提交内容仍会保留。", "Note changes that reach Git from now on appear here; current uncommitted content is kept.")
    });
    const action = notice.createEl("button", {
      cls: "mod-cta",
      text: checkpoint ? tr("重设为当前", "Reset to now") : tr("从现在开始", "Start from now")
    });
    action.disabled = !this.snapshot.headHash;
    action.addEventListener("click", () => void this.setCurrentStartingPoint());
  }

  private renderSummary(container: HTMLElement): void {
    if (!this.snapshot) return;
    const active = this.pendingItems.filter((entry) => !entry.snoozed);
    const snoozed = this.pendingItems.length - active.length;
    const summary = container.createDiv({ cls: "git-review-inbox-summary" });
    const branch = summary.createDiv({ cls: "git-review-inbox-branch" });
    const branchIcon = branch.createSpan();
    setIcon(branchIcon, "git-branch");
    branch.createSpan({ text: this.snapshot.branch });

    const metrics = summary.createDiv({ cls: "git-review-inbox-metrics" });
    this.renderMetric(metrics, String(active.length), tr("待复查", "To review"));
    this.renderMetric(
      metrics,
      String(active.filter((entry) => entry.item.committedChange).length),
      tr("已提交", "Committed")
    );
    this.renderMetric(
      metrics,
      String(active.filter((entry) => entry.item.workspaceChange).length),
      tr("未提交", "Uncommitted")
    );
    if (snoozed > 0) this.renderMetric(metrics, String(snoozed), tr("稍后", "Later"));

    const markAll = summary.createEl("button", {
      cls: "git-review-inbox-mark-all",
      text: tr("全部确认", "Confirm all")
    });
    markAll.disabled = active.length === 0;
    markAll.addEventListener("click", () => this.confirmMarkAllReviewed());
  }

  private renderMetric(container: HTMLElement, value: string, label: string): void {
    const metric = container.createDiv({ cls: "git-review-inbox-metric" });
    metric.createEl("strong", { text: value });
    metric.createSpan({ text: label });
  }

  private renderControls(container: HTMLElement): void {
    const controls = container.createDiv({ cls: "git-review-inbox-controls" });
    const search = new SearchComponent(controls.createDiv({ cls: "git-review-inbox-search" }));
    search.setPlaceholder(tr("筛选笔记或目录", "Filter notes or folders")).setValue(this.query).onChange((value) => {
      this.query = value.trim().toLocaleLowerCase();
      this.render();
    });

    const filter = controls.createEl("button", {
      cls: "git-review-inbox-filter",
      attr: { "aria-label": tr("筛选复查收件箱", "Filter the review inbox") }
    });
    const filterIcon = filter.createSpan();
    setIcon(filterIcon, "list-filter");
    filter.createSpan({ text: FILTER_LABELS[this.filter] });
    const chevron = filter.createSpan();
    setIcon(chevron, "chevron-down");
    filter.addEventListener("click", (event) => this.openFilterMenu(event));
  }

  private renderItems(container: HTMLElement): void {
    const query = this.query;
    const visibleEntries = this.pendingItems.filter((entry) => {
      if (!reviewInboxItemMatchesFilter(entry.item, this.filter, entry.snoozed)) return false;
      if (!query) return true;
      return `${entry.item.vaultPath} ${entry.item.latestCommit?.subject ?? ""}`
        .toLocaleLowerCase()
        .includes(query);
    });

    if (visibleEntries.length === 0) {
      const empty = container.createDiv({ cls: "git-workspace-review-empty git-review-inbox-empty" });
      const emptyIcon = empty.createSpan({ cls: "git-workspace-review-empty-icon" });
      setIcon(emptyIcon, query ? "search-x" : this.filter === "snoozed" ? "clock-3" : "circle-check");
      empty.createEl("h5", {
        text: query ? tr("没有匹配的笔记", "No matching notes") : this.filter === "snoozed" ? tr("没有稍后处理的笔记", "No notes set aside for later") : tr("收件箱已清空", "Inbox is empty")
      });
      empty.createEl("p", {
        text: query
          ? tr(`没有找到“${query}”。`, `Nothing found for "${query}".`)
          : this.filter === "snoozed"
            ? tr("暂时没有被推迟的变化。", "No changes are postponed.")
            : tr("当前筛选下没有需要确认的变化。", "No changes to confirm under this filter.")
      });
      return;
    }

    const byItem = new Map(visibleEntries.map((entry) => [entry.item, entry]));
    const list = container.createDiv({ cls: "git-review-inbox-list" });
    for (const group of groupReviewInboxItems(visibleEntries.map((entry) => entry.item))) {
      const section = list.createDiv({ cls: `git-review-inbox-group is-${group.key}` });
      const groupHeader = section.createDiv({ cls: "git-review-inbox-group-header" });
      const title = groupHeader.createDiv({ cls: "git-review-inbox-group-title" });
      const icon = title.createSpan();
      setIcon(icon, group.icon);
      title.createSpan({ text: group.label });
      title.createSpan({ cls: "git-review-inbox-group-count", text: String(group.items.length) });
      groupHeader.createSpan({ text: group.description });
      const rows = section.createDiv({ cls: "git-review-inbox-rows" });
      for (const item of group.items) {
        const entry = byItem.get(item);
        if (entry) this.renderItem(rows, entry);
      }
    }
  }

  private renderItem(container: HTMLElement, entry: PendingInboxItem): void {
    const { item } = entry;
    const note = workspaceNoteLabel(item.vaultPath);
    const row = container.createDiv({
      cls: `git-review-inbox-row ${entry.snoozed ? "is-snoozed" : ""}`
    });
    const open = row.createEl("button", {
      cls: "git-review-inbox-open",
      attr: {
        "aria-label": tr(`审阅 ${note.title}`, `Review ${note.title}`),
        title: item.vaultPath,
        type: "button"
      }
    });
    const status = open.createSpan({ cls: "git-review-inbox-status" });
    setIcon(
      status,
      item.workspaceChange?.conflicted
        ? "triangle-alert"
        : item.workspaceChange
          ? "file-pen-line"
          : "git-commit-horizontal"
    );
    const body = open.createSpan({ cls: "git-review-inbox-row-body" });
    const identity = body.createSpan({ cls: "git-review-inbox-identity" });
    identity.createSpan({ cls: "git-review-inbox-name", text: note.title });
    identity.createSpan({ cls: "git-review-inbox-folder", text: note.folder });
    const detail = body.createSpan({ cls: "git-review-inbox-detail" });
    if (item.latestCommit) {
      detail.createSpan({
        text: tr(`${item.latestCommit.subject || "Git 版本"} · ${this.formatDate(item.latestCommit.authoredAt)}`, `${item.latestCommit.subject || "Git version"} · ${this.formatDate(item.latestCommit.authoredAt)}`)
      });
    } else if (item.workspaceChange?.untracked) {
      detail.createSpan({ text: tr("尚未进入 Git 的新笔记", "New note not yet in Git") });
    } else {
      detail.createSpan({ text: tr("当前工作区有新变化", "New changes in the working copy") });
    }
    const badges = body.createSpan({ cls: "git-review-inbox-badges" });
    if (item.committedChange) badges.createSpan({ text: tr("已提交", "Committed") });
    if (item.workspaceChange) badges.createSpan({ text: tr("未提交", "Uncommitted") });
    if (entry.snoozed) badges.createSpan({ cls: "is-snoozed", text: tr("稍后", "Later") });
    if (!item.binary && (item.addedLines > 0 || item.deletedLines > 0)) {
      const stats = badges.createSpan({ cls: "git-review-inbox-line-stats" });
      if (item.addedLines > 0) stats.createSpan({ cls: "is-added", text: `+${item.addedLines}` });
      if (item.deletedLines > 0) stats.createSpan({ cls: "is-removed", text: `−${item.deletedLines}` });
    }
    open.addEventListener("click", () => void this.openItem(entry));

    const actions = row.createDiv({ cls: "git-review-inbox-row-actions" });
    const snooze = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": entry.snoozed ? tr("移回待复查", "Move back to review") : tr("24 小时后再提醒", "Remind me in 24 hours") }
    });
    setIcon(snooze, entry.snoozed ? "undo-2" : "clock-3");
    snooze.addEventListener("click", () => void this.toggleSnooze(entry));
    const mark = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": tr("标记已复查", "Mark as reviewed") }
    });
    setIcon(mark, "check");
    mark.addEventListener("click", () => void this.markItemReviewed(entry));
  }

  private openFilterMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const filter of Object.keys(FILTER_LABELS) as ReviewInboxFilter[]) {
      menu.addItem((item) =>
        item
          .setTitle(FILTER_LABELS[filter])
          .setIcon(filter === "snoozed" ? "clock-3" : filter === "working" ? "file-pen-line" : "inbox")
          .setChecked(this.filter === filter)
          .onClick(() => {
            this.filter = filter;
            this.render();
          })
      );
    }
    menu.showAtMouseEvent(event);
  }

  private async setCurrentStartingPoint(): Promise<void> {
    if (!this.snapshot?.headHash) return;
    await this.plugin.setReviewInboxCheckpoint(
      this.snapshot.context.repositoryRoot,
      this.snapshot.headHash
    );
    new Notice(tr("已从当前 Git 版本开始追踪待复查变化。", "Now tracking changes to review from the current Git version."));
    await this.refresh();
  }

  private confirmMarkAllReviewed(): void {
    if (!this.snapshot) return;
    const active = this.pendingItems.filter((entry) => !entry.snoozed);
    if (!active.length) return;
    new ConfirmActionModal(
      this.app,
      tr("确认全部复查完成？", "Confirm everything as reviewed?"),
      tr(`将把 ${active.length} 篇笔记记录为已复查，并以当前 Git 版本作为新的全库起点。不会提交或修改任何笔记。`, `${active.length} notes will be recorded as reviewed, with the current Git version as the new starting point for the vault. Nothing is committed and no note changes.`),
      tr("全部确认", "Confirm all"),
      async () => {
        if (!this.snapshot) return;
        await this.plugin.markInboxItemsReviewed(
          this.snapshot.context.repositoryRoot,
          this.snapshot.headHash,
          active.map((entry) => ({
            context: this.itemContext(this.snapshot!, entry.item),
            ...(entry.item.latestCommit ? { latestCommit: entry.item.latestCommit } : {}),
            ...(entry.workingFingerprint ? { workingFingerprint: entry.workingFingerprint } : {})
          }))
        );
        new Notice(tr(`已确认 ${active.length} 篇笔记。`, `${active.length} notes confirmed.`));
        await this.refresh();
      }
    ).open();
  }

  private async markItemReviewed(entry: PendingInboxItem): Promise<void> {
    if (!this.snapshot) return;
    const latestCommit = entry.item.latestCommit ?? (
      entry.item.committedChange && this.snapshot.headHash
        ? {
            hash: this.snapshot.headHash,
            shortHash: this.snapshot.headHash.slice(0, 7),
            authoredAt: new Date().toISOString(),
            subject: tr("当前全库版本", "Current vault version")
          }
        : undefined
    );
    await this.plugin.markInboxItemReviewed(
      this.itemContext(this.snapshot, entry.item),
      latestCommit,
      entry.workingFingerprint
    );
    new Notice(tr(`已复查：${workspaceNoteLabel(entry.item.vaultPath).title}`, `Reviewed: ${workspaceNoteLabel(entry.item.vaultPath).title}`));
    await this.refresh();
  }

  private async toggleSnooze(entry: PendingInboxItem): Promise<void> {
    if (!this.snapshot) return;
    const until = entry.snoozed
      ? null
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await this.plugin.snoozeInboxItem(
      this.itemContext(this.snapshot, entry.item),
      until
    );
    new Notice(entry.snoozed ? tr("已移回待复查。", "Moved back to review.") : tr("已推迟 24 小时。", "Postponed for 24 hours."));
    await this.refresh();
  }

  private async openItem(entry: PendingInboxItem): Promise<void> {
    if (!this.snapshot) return;
    const item = entry.item;
    const file = this.app.vault.getFileByPath(item.vaultPath);
    if (!file) {
      const change = item.workspaceChange;
      if (
        change
        && (change.indexStatus === "D" || change.workTreeStatus === "D")
      ) {
        await this.offerDeletedFileRestore(item, item.vaultPath);
      } else {
        new Notice(tr(`笔记已不存在：${item.vaultPath}`, `The note no longer exists: ${item.vaultPath}`), 6000);
      }
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    if (item.workspaceChange?.untracked) return;

    try {
      const history = await this.plugin.gitClient.loadFileHistory(file);
      const state = this.plugin.getFileReviewState(history.context);
      const latest = item.latestCommit
        ? history.commits.find((commit) => commit.hash === item.latestCommit?.hash)
        : history.commits[0];
      const checkpoint = state.reviewCheckpoint
        ? this.commitFromCheckpoint(state.reviewCheckpoint, history.commits)
        : undefined;
      const globalCheckpoint = this.plugin.getReviewInboxCheckpoint(
        history.context.repositoryRoot
      );
      const globalBase = item.committedChange?.changeType !== "A" && globalCheckpoint
        ? this.commitFromGlobalCheckpoint(globalCheckpoint, item.originalPath ?? item.path)
        : undefined;

      if (item.workspaceChange) {
        const base = checkpoint ?? globalBase ?? latest ?? history.commits[0];
        if (!base) return;
        await this.plugin.openDetail({
          filePath: file.path,
          repositoryRoot: history.context.repositoryRoot,
          base: { kind: "commit", commit: base },
          target: { kind: "working", label: tr("当前工作区", "Working copy") },
          initialMode: this.plugin.settings.defaultDetailMode
        });
        return;
      }

      if (!latest) {
        await this.plugin.activateHistoryInMain(file);
        return;
      }
      const latestIndex = history.commits.findIndex((commit) => commit.hash === latest.hash);
      const base = checkpoint?.hash !== latest.hash
        ? checkpoint
        : globalBase ?? history.commits[latestIndex + 1];
      if (!base) {
        await this.plugin.activateHistoryInMain(file);
        return;
      }
      await this.plugin.openDetail({
        filePath: file.path,
        repositoryRoot: history.context.repositoryRoot,
        base: { kind: "commit", commit: base },
        target: { kind: "commit", commit: latest },
        initialMode: this.plugin.settings.defaultDetailMode
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private commitFromCheckpoint(
    checkpoint: NonNullable<ReturnType<GitNoteHistoryPlugin["getFileReviewState"]>["reviewCheckpoint"]>,
    commits: GitCommitVersion[]
  ): GitCommitVersion {
    return commits.find((commit) => commit.hash === checkpoint.commitHash) ?? {
      hash: checkpoint.commitHash,
      shortHash: checkpoint.commitHash.slice(0, 7),
      authorName: "",
      authorEmail: "",
      authoredAt: checkpoint.reviewedAt,
      subject: tr("上次复查点", "Last review point"),
      historicalPath: checkpoint.historicalPath,
      changeType: "M",
      addedLines: 0,
      deletedLines: 0,
      trailers: {}
    };
  }

  private commitFromGlobalCheckpoint(
    checkpoint: NonNullable<ReturnType<GitNoteHistoryPlugin["getReviewInboxCheckpoint"]>>,
    historicalPath: string
  ): GitCommitVersion {
    return {
      hash: checkpoint.commitHash,
      shortHash: checkpoint.commitHash.slice(0, 7),
      authorName: "",
      authorEmail: "",
      authoredAt: checkpoint.reviewedAt,
      subject: tr("全库复查起点", "Vault review starting point"),
      historicalPath,
      changeType: "M",
      addedLines: 0,
      deletedLines: 0,
      trailers: {}
    };
  }

  private async offerDeletedFileRestore(item: ReviewInboxItem, vaultPath: string): Promise<void> {
    if (!this.snapshot) return;
    try {
      const version = await this.plugin.gitClient.getLatestExistingContent(
        this.snapshot.context.repositoryRoot,
        item.path
      );
      new ConfirmActionModal(
        this.app,
        tr("恢复已删除笔记？", "Restore the deleted note?"),
        tr(`将从 Git ${version.hash.slice(0, 7)} 恢复到 ${vaultPath}，不会自动暂存或提交。`, `It will be restored from Git ${version.hash.slice(0, 7)} to ${vaultPath}, without staging or committing.`),
        tr("恢复笔记", "Restore note"),
        async () => {
          const normalized = normalizePath(vaultPath);
          const parts = normalized.split("/").slice(0, -1);
          let folder = "";
          for (const part of parts) {
            folder = normalizePath(folder ? `${folder}/${part}` : part);
            if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
          }
          const restored = await this.app.vault.create(normalized, version.content);
          await this.app.workspace.getLeaf(false).openFile(restored);
          new Notice(tr(`已恢复：${normalized}`, `Restored: ${normalized}`));
          await this.refresh();
        }
      ).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private itemContext(snapshot: ReviewInboxSnapshot, item: ReviewInboxItem): GitRepositoryContext {
    return {
      ...snapshot.context,
      repositoryRelativePath: item.path
    };
  }

  private formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }
}
