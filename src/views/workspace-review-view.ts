import { ItemView, Notice, SearchComponent, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type { GitWorkspaceChange, GitWorkspaceReview } from "../models";
import { ConfirmActionModal } from "../ui/confirm-modal";
import {
  groupWorkspaceChanges,
  workspaceChangePresentation,
  workspaceNoteLabel
} from "../workspace/change-presentation";

export const GIT_WORKSPACE_REVIEW_VIEW_TYPE = "git-workspace-review-view";

export class GitWorkspaceReviewView extends ItemView {
  private review: GitWorkspaceReview | null = null;
  private loading = false;
  private error = "";
  private query = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GitNoteHistoryPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_WORKSPACE_REVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "未提交笔记";
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
      this.review = await this.plugin.gitClient.loadWorkspaceReview();
    } catch (error) {
      this.review = null;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("git-workspace-review-view");
    container.toggleClass("is-compact", this.plugin.settings.density === "compact");

    const header = container.createDiv({ cls: "git-note-history-title-row" });
    header.createEl("h4", { text: "未提交笔记" });
    const refresh = header.createEl("button", {
      cls: this.loading ? "clickable-icon is-loading" : "clickable-icon",
      attr: {
        "aria-label": this.loading ? "正在检查工作区" : "刷新",
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
      loading.createSpan({ text: "正在检查未提交笔记…" });
      return;
    }
    if (this.error) {
      container.createEl("pre", { cls: "git-note-history-error", text: this.error });
      return;
    }
    if (!this.review) return;

    const summary = container.createDiv({ cls: "git-workspace-review-summary" });
    const branch = summary.createSpan({ cls: "git-workspace-review-branch" });
    const branchIcon = branch.createSpan();
    setIcon(branchIcon, "git-branch");
    branch.createSpan({ text: this.review.branch });
    summary.createSpan({
      cls: "git-workspace-review-count",
      text: `${this.review.changes.length} 篇待处理`
    });

    if (this.review.changes.length > 5 || this.query) {
      const search = new SearchComponent(container.createDiv({ cls: "git-note-history-search" }));
      search.setPlaceholder("按笔记名或目录筛选").setValue(this.query).onChange((value) => {
        this.query = value.trim().toLocaleLowerCase();
        this.render();
      });
    }

    const changes = this.review.changes.filter((change) =>
      change.path.toLocaleLowerCase().includes(this.query)
    );
    if (changes.length === 0) {
      const empty = container.createDiv({ cls: "git-workspace-review-empty" });
      const emptyIcon = empty.createSpan({ cls: "git-workspace-review-empty-icon" });
      setIcon(emptyIcon, this.query ? "search-x" : "circle-check");
      empty.createEl("h5", { text: this.query ? "没有匹配的笔记" : "没有待处理的笔记" });
      empty.createEl("p", {
        text: this.query ? `没有找到“${this.query}”。` : "所有 Markdown 笔记改动都已提交。"
      });
      if (this.query) {
        const clear = empty.createEl("button", { text: "清除筛选" });
        clear.addEventListener("click", () => {
          this.query = "";
          this.render();
        });
      }
      return;
    }

    const list = container.createDiv({ cls: "git-workspace-review-list" });
    for (const group of groupWorkspaceChanges(changes)) {
      const section = list.createDiv({ cls: `git-workspace-review-group is-${group.presentation.key}` });
      const groupHeader = section.createDiv({ cls: "git-workspace-review-group-header" });
      const groupTitle = groupHeader.createDiv({ cls: "git-workspace-review-group-title" });
      const groupIcon = groupTitle.createSpan();
      setIcon(groupIcon, group.presentation.icon);
      groupTitle.createSpan({ text: group.presentation.label });
      groupTitle.createSpan({ cls: "git-workspace-review-group-count", text: String(group.changes.length) });
      groupHeader.createSpan({
        cls: "git-workspace-review-group-description",
        text: group.presentation.description
      });
      const rows = section.createDiv({ cls: "git-workspace-review-group-rows" });
      for (const change of group.changes) this.renderChange(rows, change);
    }
  }

  private renderChange(container: HTMLElement, change: GitWorkspaceChange): void {
    if (!this.review) return;
    const presentation = workspaceChangePresentation(change);
    const note = workspaceNoteLabel(change.path);
    const row = container.createEl("button", {
      cls: `git-workspace-review-row is-${presentation.key}`,
      attr: {
        "aria-label": `${note.title}，${presentation.label}`,
        title: change.path,
        type: "button"
      }
    });
    const icon = row.createSpan({ cls: "git-workspace-review-icon" });
    setIcon(icon, presentation.icon);
    const body = row.createSpan({ cls: "git-workspace-review-content" });
    body.createSpan({ cls: "git-workspace-review-name", text: note.title });
    body.createSpan({ cls: "git-workspace-review-path", text: note.folder });
    if (change.originalPath) {
      const original = workspaceNoteLabel(change.originalPath);
      body.createSpan({ cls: "git-workspace-review-original", text: `原位置：${original.folder} / ${original.title}` });
    }

    const trailing = row.createSpan({ cls: "git-workspace-review-trailing" });
    const stats = trailing.createSpan({ cls: "git-workspace-review-stats" });
    if (change.binary) {
      stats.createSpan({ cls: "is-neutral", text: "二进制" });
    } else {
      if (change.addedLines > 0) stats.createSpan({ cls: "is-added", text: `+${change.addedLines}` });
      if (change.deletedLines > 0) stats.createSpan({ cls: "is-removed", text: `−${change.deletedLines}` });
    }
    const chevron = trailing.createSpan({ cls: "git-workspace-review-chevron" });
    setIcon(chevron, "chevron-right");

    row.addEventListener("click", () => void this.openChange(change));
  }

  private async openChange(change: GitWorkspaceChange): Promise<void> {
    if (!this.review) return;
    const context = {
      ...this.review.context,
      repositoryRelativePath: change.path
    };
    const vaultPath = this.plugin.gitClient.repositoryPathToVaultPath(context, change.path);
    const file = this.app.vault.getFileByPath(vaultPath);
    if (!file) {
      if (change.indexStatus === "D" || change.workTreeStatus === "D") {
        await this.offerDeletedFileRestore(change, vaultPath);
      } else {
        new Notice(`笔记已不存在：${vaultPath}`, 6000);
      }
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    if (change.untracked) return;

    try {
      const history = await this.plugin.gitClient.loadFileHistory(file);
      const latest = history.commits[0];
      if (!latest) return;
      await this.plugin.openDetail({
        filePath: file.path,
        repositoryRoot: history.context.repositoryRoot,
        base: { kind: "commit", commit: latest },
        target: { kind: "working", label: "当前工作区" },
        initialMode: this.plugin.settings.defaultDetailMode
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private async offerDeletedFileRestore(change: GitWorkspaceChange, vaultPath: string): Promise<void> {
    if (!this.review) return;
    try {
      const version = await this.plugin.gitClient.getLatestExistingContent(
        this.review.context.repositoryRoot,
        change.path
      );
      new ConfirmActionModal(
        this.app,
        "恢复已删除笔记？",
        `将从 Git ${version.hash.slice(0, 7)} 恢复到 ${vaultPath}，不会自动暂存或提交。`,
        "恢复笔记",
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
          new Notice(`已恢复：${normalized}`);
          await this.refresh();
        }
      ).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }
}
