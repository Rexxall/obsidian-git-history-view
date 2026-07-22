import { ItemView, Notice, SearchComponent, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type { GitWorkspaceChange, GitWorkspaceReview } from "../models";
import { ConfirmActionModal } from "../ui/confirm-modal";

export const GIT_WORKSPACE_REVIEW_VIEW_TYPE = "git-workspace-review-view";

function statusText(change: GitWorkspaceChange): string {
  if (change.conflicted) return "冲突";
  if (change.untracked) return "新增";
  if (change.indexStatus === "R") return "重命名";
  if (change.indexStatus === "D" || change.workTreeStatus === "D") return "删除";
  if (change.indexStatus !== " " && change.workTreeStatus !== " ") return "暂存 + 修改";
  if (change.indexStatus !== " ") return "已暂存";
  return "未暂存";
}

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
    return "Git workspace review";
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
    header.createEl("h4", { text: "工作区改动" });
    const refresh = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "刷新" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());

    const search = new SearchComponent(container.createDiv({ cls: "git-note-history-search" }));
    search.setPlaceholder("筛选修改的笔记").setValue(this.query).onChange((value) => {
      this.query = value.trim().toLocaleLowerCase();
      this.render();
    });

    if (this.loading) {
      container.createDiv({ cls: "git-note-history-loading", text: "正在检查 Git 工作区…" });
      return;
    }
    if (this.error) {
      container.createEl("pre", { cls: "git-note-history-error", text: this.error });
      return;
    }
    if (!this.review) return;

    const summary = container.createDiv({ cls: "git-workspace-review-summary" });
    summary.createSpan({ text: `分支：${this.review.branch}` });
    summary.createSpan({ text: `${this.review.changes.length} 篇 Markdown 有改动` });

    const changes = this.review.changes.filter((change) =>
      change.path.toLocaleLowerCase().includes(this.query)
    );
    if (changes.length === 0) {
      container.createDiv({ cls: "git-note-history-empty", text: this.query ? "没有匹配的笔记。" : "Markdown 工作区目前没有未提交改动。" });
      return;
    }

    const list = container.createDiv({ cls: "git-workspace-review-list" });
    for (const change of changes) this.renderChange(list, change);
  }

  private renderChange(container: HTMLElement, change: GitWorkspaceChange): void {
    if (!this.review) return;
    const row = container.createEl("button", { cls: "git-workspace-review-row" });
    const icon = row.createSpan({ cls: "git-workspace-review-icon" });
    setIcon(icon, change.conflicted ? "triangle-alert" : change.untracked ? "file-plus-2" : "file-diff");
    const body = row.createSpan({ cls: "git-workspace-review-content" });
    body.createSpan({ cls: "git-workspace-review-path", text: change.path });
    if (change.originalPath) body.createSpan({ cls: "git-workspace-review-original", text: `来自 ${change.originalPath}` });

    const meta = row.createSpan({ cls: "git-workspace-review-meta" });
    meta.createSpan({ cls: change.conflicted ? "is-conflicted" : "", text: statusText(change) });
    meta.createSpan({ cls: "is-added", text: `+${change.addedLines}` });
    meta.createSpan({ cls: "is-removed", text: `−${change.deletedLines}` });

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
