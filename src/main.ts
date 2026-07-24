import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { GitClient } from "./git/git-client";
import type {
  DetailMode,
  DetailRequest,
  FileReviewState,
  GitCommitVersion,
  GitNoteHistorySettings,
  GitRepositoryContext,
  PersistedPluginData,
  RestoreReceipt,
  UndoSnapshot
} from "./models";
import { RestoreService } from "./restore/restore-service";
import { DEFAULT_SETTINGS, GitNoteHistorySettingTab } from "./settings";
import {
  GIT_NOTE_HISTORY_VIEW_TYPE,
  GitNoteHistoryView
} from "./views/history-view";
import {
  GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE,
  GitHistoryDetailView
} from "./views/detail-view";
import {
  GIT_WORKSPACE_REVIEW_VIEW_TYPE,
  GitWorkspaceReviewView
} from "./views/workspace-review-view";
import { LineHistoryModal } from "./ui/line-history-modal";
import {
  GIT_CONFLICT_RESOLVER_VIEW_TYPE,
  GitConflictResolverView
} from "./views/conflict-resolver-view";
import { RestoreHistoryModal } from "./ui/restore-history-modal";
import { contentFingerprint } from "./history/version-groups";
import { BlockAgeModal } from "./ui/block-age-modal";

export default class GitNoteHistoryPlugin extends Plugin {
  settings: GitNoteHistorySettings = { ...DEFAULT_SETTINGS };
  gitClient!: GitClient;
  restoreService!: RestoreService;
  private undoStack: UndoSnapshot[] = [];
  private restoreReceipts: RestoreReceipt[] = [];
  private fileReviewStates: Record<string, FileReviewState> = {};

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.gitClient = new GitClient(this.app, () => this.settings);
    this.restoreService = new RestoreService(this.app, {
      getStack: () => this.undoStack,
      setStack: async (stack) => {
        this.undoStack = stack;
        await this.savePluginData();
      },
      getReceipts: () => this.restoreReceipts,
      setReceipts: async (receipts) => {
        this.restoreReceipts = receipts;
        await this.savePluginData();
      }
    });

    this.registerView(
      GIT_NOTE_HISTORY_VIEW_TYPE,
      (leaf) => new GitNoteHistoryView(leaf, this)
    );
    this.registerView(
      GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE,
      (leaf) => new GitHistoryDetailView(leaf, this)
    );
    this.registerView(
      GIT_WORKSPACE_REVIEW_VIEW_TYPE,
      (leaf) => new GitWorkspaceReviewView(leaf, this)
    );
    this.registerView(
      GIT_CONFLICT_RESOLVER_VIEW_TYPE,
      (leaf) => new GitConflictResolverView(leaf, this)
    );

    this.addRibbonIcon("history", "打开当前笔记的 Git 历史", () => {
      void this.activateHistoryView(this.app.workspace.getActiveFile());
    });
    this.addRibbonIcon("list-checks", "查看未提交笔记", () => {
      void this.activateWorkspaceReview();
    });

    this.addCommand({
      id: "open-current-note-git-history",
      name: "打开当前笔记的 Git 历史",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) void this.activateHistoryView(file);
        return available;
      }
    });

    this.addCommand({
      id: "open-git-workspace-review",
      name: "打开未提交笔记面板",
      callback: () => void this.activateWorkspaceReview()
    });

    this.addCommand({
      id: "open-current-note-git-history-main",
      name: "在中央完整打开当前笔记的 Git 时间线",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) void this.activateHistoryInMain(file);
        return available;
      }
    });

    this.addCommand({
      id: "show-selected-paragraph-history",
      name: "查看当前段落或选中文本的 Git 历史",
      editorCheckCallback: (checking, editor, view) => {
        if (!view.file || view.file.extension !== "md") return false;
        if (!checking) {
          const selection = editor.listSelections()[0];
          const cursor = editor.getCursor();
          let start = selection ? Math.min(selection.anchor.line, selection.head.line) : cursor.line;
          let end = selection ? Math.max(selection.anchor.line, selection.head.line) : cursor.line;
          if (!editor.somethingSelected()) {
            while (start > 0 && editor.getLine(start - 1).trim() !== "") start -= 1;
            while (end < editor.lineCount() - 1 && editor.getLine(end + 1).trim() !== "") end += 1;
          }
          const selectedText = Array.from({ length: end - start + 1 }, (_, index) =>
            editor.getLine(start + index)
          ).join("\n");
          new LineHistoryModal(this.app, this, view.file, start + 1, end + 1, selectedText).open();
        }
        return true;
      }
    });

    this.addCommand({
      id: "show-current-note-content-age",
      name: "打开当前笔记的内容年龄镜头",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) new BlockAgeModal(this.app, this, file).open();
        return available;
      }
    });

    this.addCommand({
      id: "resolve-current-note-git-conflict",
      name: "打开当前笔记的三栏 Git 冲突解决器",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) void this.activateConflictResolver(file);
        return available;
      }
    });

    this.addCommand({
      id: "refresh-current-note-git-history",
      name: "刷新当前笔记的 Git 历史",
      callback: () => this.refreshOpenViews()
    });

    this.addCommand({
      id: "undo-last-git-restore",
      name: "撤销上次 Git 恢复",
      checkCallback: (checking) => {
        if (!this.restoreService.canUndo()) return false;
        if (!checking) {
          void this.restoreService
            .undoLastRestore()
            .then(async (file) => {
              await this.app.workspace.getLeaf(false).openFile(file);
              this.refreshOpenViews();
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : String(error), 8000);
            });
        }
        return true;
      }
    });

    this.addCommand({
      id: "show-git-restore-history",
      name: "查看 Git 恢复历史与撤销栈",
      callback: () => new RestoreHistoryModal(this.app, this).open()
    });

    this.addCommand({
      id: "mark-current-note-git-history-reviewed",
      name: "把当前笔记标记为已复查",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) {
          void (async () => {
            try {
              const [history, content] = await Promise.all([
                this.gitClient.loadFileHistory(file),
                this.app.vault.read(file)
              ]);
              const latest = history.commits[0];
              if (!latest) {
                new Notice("这篇笔记还没有可作为复查点的 Git 提交。");
                return;
              }
              await this.markReviewed(history.context, latest, contentFingerprint(content));
              new Notice(`已复查到 ${latest.shortHash}。`);
              this.refreshOpenViews();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error), 8000);
            }
          })();
        }
        return available;
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("查看 Git 历史")
            .setIcon("history")
            .onClick(() => void this.activateHistoryView(file))
        );
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        void this.restoreService.renameFilePath(oldPath, file.path);
      })
    );

    this.addSettingTab(new GitNoteHistorySettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(GIT_NOTE_HISTORY_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_WORKSPACE_REVIEW_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_CONFLICT_RESOLVER_VIEW_TYPE);
  }

  async activateWorkspaceReview(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(GIT_WORKSPACE_REVIEW_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: GIT_WORKSPACE_REVIEW_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof GitWorkspaceReviewView) await leaf.view.refresh();
  }

  async openDetail(request: DetailRequest): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof GitHistoryDetailView) await leaf.view.setRequest(request);
  }

  async activateConflictResolver(file: TFile | null): Promise<void> {
    if (!file || file.extension !== "md") {
      new Notice("请先打开一篇存在 Git 冲突的 Markdown 笔记。");
      return;
    }
    let leaf = this.app.workspace.getLeavesOfType(GIT_CONFLICT_RESOLVER_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: GIT_CONFLICT_RESOLVER_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof GitConflictResolverView) await leaf.view.setFile(file);
  }

  async openFileAtLine(file: TFile, line: number): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (leaf.view instanceof MarkdownView) {
      const targetLine = Math.max(0, Math.min(line, leaf.view.editor.lineCount() - 1));
      leaf.view.editor.setCursor({ line: targetLine, ch: 0 });
      leaf.view.editor.scrollIntoView({
        from: { line: targetLine, ch: 0 },
        to: { line: targetLine, ch: leaf.view.editor.getLine(targetLine).length }
      }, true);
      leaf.view.editor.focus();
    }
  }

  async activateHistoryView(file: TFile | null): Promise<void> {
    let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(
      GIT_NOTE_HISTORY_VIEW_TYPE
    )[0];

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: GIT_NOTE_HISTORY_VIEW_TYPE, active: true });
    }

    await this.app.workspace.revealLeaf(leaf);
    if (file?.extension === "md" && leaf.view instanceof GitNoteHistoryView) {
      await leaf.view.setFile(file);
    }
  }

  async activateHistoryInMain(file: TFile | null): Promise<void> {
    if (!file || file.extension !== "md") {
      new Notice("请先打开一篇 Markdown 笔记。");
      return;
    }
    let leaf = this.app.workspace.getLeavesOfType(GIT_NOTE_HISTORY_VIEW_TYPE)
      .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: GIT_NOTE_HISTORY_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof GitNoteHistoryView) await leaf.view.setFile(file);
  }

  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_NOTE_HISTORY_VIEW_TYPE)) {
      if (leaf.view instanceof GitNoteHistoryView) void leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE)) {
      if (leaf.view instanceof GitHistoryDetailView) void leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_WORKSPACE_REVIEW_VIEW_TYPE)) {
      if (leaf.view instanceof GitWorkspaceReviewView) void leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_CONFLICT_RESOLVER_VIEW_TYPE)) {
      if (leaf.view instanceof GitConflictResolverView) void leaf.view.refresh();
    }
  }

  getFileReviewState(context: GitRepositoryContext): FileReviewState {
    const key = this.reviewStateKey(context);
    const existing = this.fileReviewStates[key];
    if (existing) return existing;
    const state: FileReviewState = { bookmarks: {} };
    this.fileReviewStates[key] = state;
    return state;
  }

  async setBaseline(context: GitRepositoryContext, commit: GitCommitVersion | null): Promise<void> {
    const state = this.getFileReviewState(context);
    if (commit) {
      state.baselineHash = commit.hash;
      state.baselinePath = commit.historicalPath;
    } else {
      delete state.baselineHash;
      delete state.baselinePath;
    }
    await this.savePluginData();
  }

  async setVersionLabel(context: GitRepositoryContext, hash: string, label: string): Promise<void> {
    const state = this.getFileReviewState(context);
    if (label) state.bookmarks[hash] = { label, createdAt: new Date().toISOString() };
    else delete state.bookmarks[hash];
    await this.savePluginData();
  }

  async markReviewed(
    context: GitRepositoryContext,
    commit: GitCommitVersion,
    workingFingerprint?: string
  ): Promise<void> {
    const state = this.getFileReviewState(context);
    state.reviewCheckpoint = {
      commitHash: commit.hash,
      historicalPath: commit.historicalPath,
      reviewedAt: new Date().toISOString(),
      ...(workingFingerprint ? { workingFingerprint } : {})
    };
    await this.savePluginData();
  }

  async clearReviewCheckpoint(context: GitRepositoryContext): Promise<void> {
    const state = this.getFileReviewState(context);
    delete state.reviewCheckpoint;
    await this.savePluginData();
  }

  async rememberDetailMode(file: TFile, mode: DetailMode): Promise<void> {
    try {
      const context = await this.gitClient.resolveFileContext(file);
      this.getFileReviewState(context).detailMode = mode;
      await this.savePluginData();
    } catch {
      // A view preference should never interrupt version review if Git becomes temporarily unavailable.
    }
  }

  async migrateFileReviewState(
    previousContext: GitRepositoryContext,
    nextContext: GitRepositoryContext
  ): Promise<void> {
    const previousKey = this.reviewStateKey(previousContext);
    const nextKey = this.reviewStateKey(nextContext);
    if (previousKey === nextKey || !this.fileReviewStates[previousKey]) return;
    this.fileReviewStates[nextKey] = this.fileReviewStates[previousKey];
    delete this.fileReviewStates[previousKey];
    await this.savePluginData();
  }

  async savePluginData(): Promise<void> {
    const data: PersistedPluginData = {
      settings: this.settings,
      undoStack: this.undoStack,
      restoreReceipts: this.restoreReceipts,
      fileReviewStates: this.fileReviewStates
    };
    await this.saveData(data);
  }

  private async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as PersistedPluginData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    const legacy = data?.undoSnapshot;
    this.undoStack = (data?.undoStack ?? (legacy ? [legacy] : [])).map((snapshot, index) => ({
      ...snapshot,
      id: snapshot.id || `legacy-${index}-${snapshot.createdAt}`,
      scope: snapshot.scope ?? "file"
    }));
    this.restoreReceipts = data?.restoreReceipts ?? [];
    this.fileReviewStates = data?.fileReviewStates ?? {};
  }

  private reviewStateKey(context: GitRepositoryContext): string {
    return `${context.repositoryRoot}\u001f${context.repositoryRelativePath}`;
  }
}
