import {
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf
} from "obsidian";
import { GitClient, GitCommandError } from "./git/git-client";
import type {
  DetailMode,
  DetailRequest,
  FileReviewState,
  GitCommitVersion,
  GitNoteHistorySettings,
  GitRepositoryContext,
  PersistedPluginData,
  ReviewCommitSummary,
  ReviewInboxCheckpoint,
  RestoreReceipt,
  UndoSnapshot,
  VersionMilestoneInput
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
import {
  clearReviewCheckpointMilestone,
  projectMilestonesToBookmarks,
  setReviewCheckpointMilestone
} from "./history/milestones";
import {
  CURRENT_DATA_SCHEMA_VERSION,
  migratePluginData,
  migrateReviewStatePath
} from "./persistence/plugin-data";
import { BlockAgeModal } from "./ui/block-age-modal";
import {
  markReviewInboxItemState,
  setReviewInboxItemSnoozed
} from "./review/review-state";
import type {
  WorkEventFileChange,
  WorkEventRequest,
  WorkEventSnapshot
} from "./work-events/types";
import {
  GIT_WORK_EVENT_VIEW_TYPE,
  GitWorkEventView
} from "./views/work-event-view";
import {
  KnowledgeTraceSetupModal,
  type KnowledgeTraceSetupValue
} from "./ui/knowledge-trace-modal";
import {
  GIT_KNOWLEDGE_TRACE_VIEW_TYPE,
  GitKnowledgeTraceView,
  type KnowledgeTraceViewRun
} from "./views/knowledge-trace-view";
import {
  KnowledgeVersionMaterializer,
  type KnowledgeWorkingSnapshot
} from "./knowledge-trace/version-materializer";
import { traceKnowledgeBoundary } from "./knowledge-trace/boundary-search";

function clonePlainData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workEventSnapshotLabel(capturedAt: string): string {
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) return "工作区快照";
  const time = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
  return `工作区快照 · ${time}`;
}

export default class GitNoteHistoryPlugin extends Plugin {
  settings: GitNoteHistorySettings = { ...DEFAULT_SETTINGS };
  gitClient!: GitClient;
  restoreService!: RestoreService;
  private knowledgeVersionMaterializer!: KnowledgeVersionMaterializer;
  private undoStack: UndoSnapshot[] = [];
  private restoreReceipts: RestoreReceipt[] = [];
  private fileReviewStates: Record<string, FileReviewState> = {};
  private reviewInboxCheckpoints: Record<string, ReviewInboxCheckpoint> = {};
  private dataOperationQueue: Promise<void> = Promise.resolve();
  private detailOpenGeneration = 0;
  private pendingDetailLeaf: Promise<WorkspaceLeaf> | null = null;
  private workEventOpenGeneration = 0;
  private pendingWorkEventLeaf: Promise<WorkspaceLeaf> | null = null;
  private knowledgeTraceOpenGeneration = 0;
  private pendingKnowledgeTraceLeaf: Promise<WorkspaceLeaf> | null = null;
  private isUnloading = false;

  async onload(): Promise<void> {
    this.isUnloading = false;
    await this.loadPluginData();

    this.gitClient = new GitClient(this.app, () => this.settings);
    this.knowledgeVersionMaterializer = new KnowledgeVersionMaterializer(
      this.gitClient
    );
    this.restoreService = new RestoreService(this.app, {
      getStack: () => this.undoStack,
      getReceipts: () => this.restoreReceipts,
      mutateHistory: (mutation, shouldPersist) =>
        this.mutateRestoreHistory(mutation, shouldPersist)
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
    this.registerView(
      GIT_WORK_EVENT_VIEW_TYPE,
      (leaf) => new GitWorkEventView(leaf, this)
    );
    this.registerView(
      GIT_KNOWLEDGE_TRACE_VIEW_TYPE,
      (leaf) => new GitKnowledgeTraceView(leaf, {
        trace: (setup, signal) => this.runKnowledgeTrace(setup, signal),
        openComparison: (request) => this.openDetail(request),
        isFrozenWorkspaceStale: (filePath, snapshot) =>
          this.isKnowledgeTraceWorkspaceStale(filePath, snapshot)
      })
    );

    this.addRibbonIcon("history", "打开当前笔记的 Git 历史", () => {
      void this.activateHistoryView(this.app.workspace.getActiveFile());
    });
    this.addRibbonIcon("list-checks", "打开复查收件箱", () => {
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
      name: "打开复查收件箱",
      callback: () => void this.activateWorkspaceReview()
    });

    this.addCommand({
      id: "open-current-working-event",
      name: "查看当前未提交工作",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        void this.openWorkEvent({
          ...(file?.extension === "md" ? { anchorVaultPath: file.path } : {}),
          source: { kind: "working" }
        });
      }
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
      id: "trace-current-note-knowledge-boundary",
      name: "追踪当前笔记的知识变化边界",
      editorCheckCallback: (checking, editor, view) => {
        if (!view.file || view.file.extension !== "md") return false;
        if (!checking) {
          const selectedText = editor.somethingSelected()
            ? editor.getSelection()
            : "";
          this.openKnowledgeTraceSetup(view.file, selectedText);
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
        if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
        const includeDescendants = file instanceof TFolder;
        const nextPath = file.path;
        // Reserve the review-data migration before any modal can write to the new path.
        const reviewMigration = this.migrateVaultReviewPath(
          oldPath,
          nextPath,
          includeDescendants
        );
        const restoreMigration = this.restoreService.renameFilePath(
          oldPath,
          nextPath,
          includeDescendants
        );
        void (async () => {
          const [reviewResult, restoreResult] = await Promise.allSettled([
            reviewMigration,
            restoreMigration
          ]);
          if (reviewResult.status === "rejected") {
            const reason = reviewResult.reason;
            new Notice(
              `重命名后未能迁移版本里程碑：${reason instanceof Error ? reason.message : String(reason)}`,
              9000
            );
          }
          if (restoreResult.status === "rejected") {
            const reason = restoreResult.reason;
            new Notice(
              `重命名后未能迁移恢复记录：${reason instanceof Error ? reason.message : String(reason)}`,
              9000
            );
          }
          this.refreshOpenViews();
        })();
      })
    );

    this.addSettingTab(new GitNoteHistorySettingTab(this.app, this));
  }

  onunload(): void {
    this.isUnloading = true;
    this.detailOpenGeneration += 1;
    this.pendingDetailLeaf = null;
    this.workEventOpenGeneration += 1;
    this.pendingWorkEventLeaf = null;
    this.knowledgeTraceOpenGeneration += 1;
    this.pendingKnowledgeTraceLeaf = null;
    this.app.workspace.detachLeavesOfType(GIT_NOTE_HISTORY_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_WORKSPACE_REVIEW_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_CONFLICT_RESOLVER_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_WORK_EVENT_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_KNOWLEDGE_TRACE_VIEW_TYPE);
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
    const generation = ++this.detailOpenGeneration;
    const leaf = await this.ensureDetailLeaf();
    if (generation !== this.detailOpenGeneration) return;

    await this.app.workspace.revealLeaf(leaf);
    if (generation !== this.detailOpenGeneration) return;

    if (leaf.view instanceof GitHistoryDetailView) {
      await leaf.view.setRequest(request);
    }
  }

  private async ensureDetailLeaf(): Promise<WorkspaceLeaf> {
    const pendingLeaf = this.pendingDetailLeaf;
    if (pendingLeaf) return pendingLeaf;

    const existingLeaf = this.app.workspace
      .getLeavesOfType(GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE)[0];
    if (existingLeaf) return existingLeaf;

    const leafPromise = (async (): Promise<WorkspaceLeaf> => {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE, active: true });
      return leaf;
    })();
    this.pendingDetailLeaf = leafPromise;
    try {
      return await leafPromise;
    } finally {
      if (this.pendingDetailLeaf === leafPromise) {
        this.pendingDetailLeaf = null;
      }
    }
  }

  async openWorkEvent(request: WorkEventRequest): Promise<void> {
    const generation = ++this.workEventOpenGeneration;
    const leaf = await this.ensureWorkEventLeaf();
    if (generation !== this.workEventOpenGeneration) return;

    await this.app.workspace.revealLeaf(leaf);
    if (generation !== this.workEventOpenGeneration) return;

    if (leaf.view instanceof GitWorkEventView) {
      await leaf.view.setRequest(request);
    }
  }

  private async ensureWorkEventLeaf(): Promise<WorkspaceLeaf> {
    const pendingLeaf = this.pendingWorkEventLeaf;
    if (pendingLeaf) return pendingLeaf;

    const existingLeaf = this.app.workspace
      .getLeavesOfType(GIT_WORK_EVENT_VIEW_TYPE)
      .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
    if (existingLeaf) return existingLeaf;

    const leafPromise = (async (): Promise<WorkspaceLeaf> => {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: GIT_WORK_EVENT_VIEW_TYPE, active: true });
      return leaf;
    })();
    this.pendingWorkEventLeaf = leafPromise;
    try {
      return await leafPromise;
    } finally {
      if (this.pendingWorkEventLeaf === leafPromise) {
        this.pendingWorkEventLeaf = null;
      }
    }
  }

  openKnowledgeTraceSetup(
    file: TFile,
    selectedText = ""
  ): void {
    if (this.isUnloading) return;
    const generation = ++this.knowledgeTraceOpenGeneration;
    const initialValue = selectedText.trim()
      ? {
          assertion: {
            kind: "text" as const,
            operator: "contains" as const,
            expected: selectedText,
            caseSensitive: false,
            normalizeLineEndings: true
          }
        }
      : undefined;
    new KnowledgeTraceSetupModal(this.app, {
      filePath: file.path,
      ...(initialValue ? { initialValue } : {}),
      onSubmit: (setup) => {
        if (
          this.isUnloading
          || generation !== this.knowledgeTraceOpenGeneration
        ) return;
        void this.openKnowledgeTrace(setup);
      }
    }).open();
  }

  async openKnowledgeTrace(setup: KnowledgeTraceSetupValue): Promise<void> {
    if (this.isUnloading) return;
    const generation = ++this.knowledgeTraceOpenGeneration;
    const leaf = await this.ensureKnowledgeTraceLeaf();
    if (!leaf) return;
    if (this.isUnloading) {
      leaf.detach();
      return;
    }
    if (
      generation !== this.knowledgeTraceOpenGeneration
    ) return;

    await this.app.workspace.revealLeaf(leaf);
    if (
      this.isUnloading
      || generation !== this.knowledgeTraceOpenGeneration
    ) return;

    if (leaf.view instanceof GitKnowledgeTraceView) {
      await leaf.view.setRequest(setup);
    }
  }

  private async ensureKnowledgeTraceLeaf(): Promise<WorkspaceLeaf | null> {
    if (this.isUnloading) return null;
    const pendingLeaf = this.pendingKnowledgeTraceLeaf;
    if (pendingLeaf) return pendingLeaf;

    const existingLeaf = this.app.workspace
      .getLeavesOfType(GIT_KNOWLEDGE_TRACE_VIEW_TYPE)
      .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
    if (existingLeaf) return existingLeaf;

    const leafPromise = (async (): Promise<WorkspaceLeaf> => {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: GIT_KNOWLEDGE_TRACE_VIEW_TYPE,
        active: true
      });
      return leaf;
    })();
    this.pendingKnowledgeTraceLeaf = leafPromise;
    try {
      return await leafPromise;
    } finally {
      if (this.pendingKnowledgeTraceLeaf === leafPromise) {
        this.pendingKnowledgeTraceLeaf = null;
      }
    }
  }

  private async runKnowledgeTrace(
    setup: KnowledgeTraceSetupValue,
    signal: AbortSignal
  ): Promise<KnowledgeTraceViewRun> {
    const file = this.app.vault.getFileByPath(setup.filePath);
    if (!file || file.extension !== "md") {
      throw new GitCommandError("找不到要追踪的 Markdown 笔记。");
    }
    const materialization = await this.knowledgeVersionMaterializer.materialize(
      file,
      {
        maxVersions: setup.maxVersions,
        includeWorking: true,
        signal
      }
    );
    const result = traceKnowledgeBoundary({
      assertion: setup.assertion,
      versions: materialization.samples
    });
    return { setup, materialization, result };
  }

  private async isKnowledgeTraceWorkspaceStale(
    filePath: string,
    snapshot: KnowledgeWorkingSnapshot
  ): Promise<boolean> {
    const file = this.app.vault.getFileByPath(filePath);
    if (!file || file.extension !== "md") return true;
    return this.knowledgeVersionMaterializer.isWorkingSnapshotStale(
      file,
      snapshot
    );
  }

  async openWorkEventFileComparison(
    snapshot: WorkEventSnapshot,
    change: WorkEventFileChange
  ): Promise<void> {
    const file = this.app.vault.getFileByPath(change.vaultPath);
    if (
      !file
      || file.extension !== "md"
      || change.kind !== "markdown"
      || change.status === "A"
      || change.status === "D"
      || change.netUnchanged
      || !snapshot.baseHash
      || !snapshot.headHash
    ) {
      new Notice("这个文件缺少可读取的两端版本，请在工作事件内查看只读预览。");
      return;
    }
    const targetCommit = snapshot.commits[0];
    const oldestCommit = snapshot.commits.at(-1);
    const baseCommit: GitCommitVersion = {
      hash: snapshot.baseHash,
      shortHash: snapshot.baseHash.slice(0, 7),
      authorName: oldestCommit?.authorName ?? "",
      authorEmail: oldestCommit?.authorEmail ?? "",
      authoredAt: oldestCommit?.committedAt ?? snapshot.startedAt ?? snapshot.endedAt,
      subject: "工作事件前",
      historicalPath: change.originalRepositoryPath ?? change.repositoryPath,
      changeType: "M",
      addedLines: 0,
      deletedLines: 0,
      trailers: {}
    };
    const target: DetailRequest["target"] = snapshot.source === "working"
      ? { kind: "working", label: workEventSnapshotLabel(snapshot.capturedAt) }
      : {
          kind: "commit",
          commit: {
            hash: snapshot.headHash,
            shortHash: snapshot.headHash.slice(0, 7),
            authorName: targetCommit?.authorName ?? "",
            authorEmail: targetCommit?.authorEmail ?? "",
            authoredAt: targetCommit?.authoredAt ?? snapshot.endedAt,
            subject: targetCommit?.subject ?? "工作事件结束",
            historicalPath: change.repositoryPath,
            changeType: change.status,
            addedLines: change.addedLines,
            deletedLines: change.deletedLines,
            trailers: {}
          }
        };
    await this.openDetail({
      filePath: file.path,
      repositoryRoot: snapshot.repositoryRoot,
      base: { kind: "commit", commit: baseCommit },
      target,
      initialMode: this.settings.defaultDetailMode,
      readOnly: true,
      ...(change.beforeContent !== undefined
        ? { baseContentOverride: change.beforeContent }
        : {}),
      ...(change.afterContent !== undefined
        ? { targetContentOverride: change.afterContent }
        : {})
    });
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
    return this.getFileReviewStateFrom(this.fileReviewStates, context);
  }

  private getFileReviewStateFrom(
    states: Record<string, FileReviewState>,
    context: GitRepositoryContext
  ): FileReviewState {
    const key = this.reviewStateKey(context);
    const existing = states[key];
    if (existing) return existing;
    const state: FileReviewState = { bookmarks: {}, milestones: {} };
    states[key] = state;
    return state;
  }

  private enqueueDataOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.dataOperationQueue.then(operation);
    this.dataOperationQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  private pluginDataSnapshot(
    fileReviewStates = this.fileReviewStates,
    reviewInboxCheckpoints = this.reviewInboxCheckpoints,
    undoStack = this.undoStack,
    restoreReceipts = this.restoreReceipts
  ): PersistedPluginData {
    return {
      schemaVersion: CURRENT_DATA_SCHEMA_VERSION,
      settings: this.settings,
      undoStack,
      restoreReceipts,
      fileReviewStates,
      reviewInboxCheckpoints
    };
  }

  private mutateReviewData<T>(
    mutation: (
      states: Record<string, FileReviewState>,
      checkpoints: Record<string, ReviewInboxCheckpoint>
    ) => T | Promise<T>,
    shouldPersist: (result: T) => boolean = () => true
  ): Promise<T> {
    return this.enqueueDataOperation(async () => {
      const nextStates = clonePlainData(this.fileReviewStates);
      const nextCheckpoints = clonePlainData(this.reviewInboxCheckpoints);
      const result = await mutation(nextStates, nextCheckpoints);
      if (!shouldPersist(result)) return result;
      await this.saveData(this.pluginDataSnapshot(nextStates, nextCheckpoints));
      this.fileReviewStates = nextStates;
      this.reviewInboxCheckpoints = nextCheckpoints;
      return result;
    });
  }

  async setBaseline(context: GitRepositoryContext, commit: GitCommitVersion | null): Promise<void> {
    await this.mutateReviewData((states) => {
      const state = this.getFileReviewStateFrom(states, context);
      if (commit) {
        state.baselineHash = commit.hash;
        state.baselinePath = commit.historicalPath;
      } else {
        delete state.baselineHash;
        delete state.baselinePath;
      }
    });
  }

  async setVersionMilestone(
    context: GitRepositoryContext,
    commit: GitCommitVersion,
    milestoneId: string | null,
    milestone: VersionMilestoneInput | null
  ): Promise<string | null> {
    return this.mutateReviewData((states) => {
      const state = this.getFileReviewStateFrom(states, context);
      const milestones = state.milestones ??= {};
      if (milestone) {
        if (milestone.kind === "review-checkpoint") {
          throw new Error("复查点由复查流程管理，不能手动创建。");
        }
        const id = milestoneId
          ?? `milestone:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
        const existing = milestones[id];
        const createdAt = existing?.createdAt || new Date().toISOString();
        milestones[id] = {
          id,
          label: milestone.label.trim(),
          kind: milestone.kind,
          commitHash: commit.hash,
          historicalPath: commit.historicalPath,
          commitAuthoredAt: commit.authoredAt,
          commitSubject: commit.subject,
          occurredAt: milestone.occurredAt,
          createdAt,
          source: "local-user",
          ...(milestone.note?.trim() ? { note: milestone.note.trim() } : {})
        };
        state.bookmarks = projectMilestonesToBookmarks(milestones);
        return id;
      }
      if (milestoneId) delete milestones[milestoneId];
      state.bookmarks = projectMilestonesToBookmarks(milestones);
      return null;
    });
  }

  async hydrateVersionMilestones(
    context: GitRepositoryContext,
    commits: readonly GitCommitVersion[]
  ): Promise<boolean> {
    return this.mutateReviewData((states) => {
      const state = this.getFileReviewStateFrom(states, context);
      const milestones = state.milestones ?? {};
      const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
      let changed = false;
      for (const milestone of Object.values(milestones)) {
        const commit = commitsByHash.get(milestone.commitHash);
        if (!commit) continue;
        if (!milestone.historicalPath) {
          milestone.historicalPath = commit.historicalPath;
          changed = true;
        }
        if (!milestone.commitAuthoredAt) {
          milestone.commitAuthoredAt = commit.authoredAt;
          changed = true;
        }
        if (!milestone.commitSubject) {
          milestone.commitSubject = commit.subject;
          changed = true;
        }
      }
      if (changed) state.bookmarks = projectMilestonesToBookmarks(milestones);
      return changed;
    }, (changed) => changed);
  }

  async markReviewed(
    context: GitRepositoryContext,
    commit: GitCommitVersion,
    workingFingerprint?: string
  ): Promise<void> {
    await this.mutateReviewData((states) => {
      const state = this.getFileReviewStateFrom(states, context);
      setReviewCheckpointMilestone(
        state,
        commit,
        new Date().toISOString(),
        workingFingerprint
      );
    });
  }

  getReviewInboxCheckpoint(repositoryRoot: string): ReviewInboxCheckpoint | undefined {
    return this.reviewInboxCheckpoints[repositoryRoot];
  }

  async setReviewInboxCheckpoint(repositoryRoot: string, commitHash: string): Promise<void> {
    await this.mutateReviewData((_states, checkpoints) => {
      if (commitHash) {
        checkpoints[repositoryRoot] = {
          commitHash,
          reviewedAt: new Date().toISOString()
        };
      } else {
        delete checkpoints[repositoryRoot];
      }
    });
  }

  async markInboxItemReviewed(
    context: GitRepositoryContext,
    latestCommit?: ReviewCommitSummary,
    workingFingerprint?: string
  ): Promise<void> {
    await this.mutateReviewData((states) => {
      this.updateInboxItemReviewed(
        context,
        latestCommit,
        workingFingerprint,
        new Date().toISOString(),
        states
      );
    });
  }

  async markInboxItemsReviewed(
    repositoryRoot: string,
    headHash: string,
    items: Array<{
      context: GitRepositoryContext;
      latestCommit?: ReviewCommitSummary;
      workingFingerprint?: string;
    }>
  ): Promise<void> {
    await this.mutateReviewData((states, checkpoints) => {
      const reviewedAt = new Date().toISOString();
      if (headHash) {
        checkpoints[repositoryRoot] = { commitHash: headHash, reviewedAt };
      }
      for (const item of items) {
        this.updateInboxItemReviewed(
          item.context,
          item.latestCommit,
          item.workingFingerprint,
          reviewedAt,
          states
        );
      }
    });
  }

  async snoozeInboxItem(context: GitRepositoryContext, until: string | null): Promise<void> {
    await this.mutateReviewData((states) => {
      const state = this.getFileReviewStateFrom(states, context);
      setReviewInboxItemSnoozed(state, until);
    });
  }

  async clearReviewCheckpoint(context: GitRepositoryContext): Promise<void> {
    await this.mutateReviewData((states) => {
      const state = this.getFileReviewStateFrom(states, context);
      clearReviewCheckpointMilestone(state);
    });
  }

  async rememberDetailMode(file: TFile, mode: DetailMode): Promise<void> {
    try {
      const context = await this.gitClient.resolveFileContext(file);
      await this.mutateReviewData((states) => {
        this.getFileReviewStateFrom(states, context).detailMode = mode;
      });
    } catch {
      // A view preference should never interrupt version review if Git becomes temporarily unavailable.
    }
  }

  async migrateFileReviewState(
    previousContext: GitRepositoryContext,
    nextContext: GitRepositoryContext
  ): Promise<void> {
    await this.mutateReviewData((states) => {
      return migrateReviewStatePath(
        states,
        previousContext,
        nextContext
      );
    }, (changed) => changed);
  }

  private migrateVaultReviewPath(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean
  ): Promise<boolean> {
    return this.mutateReviewData(async (states) => {
      let previousContext: GitRepositoryContext;
      let nextContext: GitRepositoryContext;
      try {
        [previousContext, nextContext] = await Promise.all([
          this.gitClient.resolveVaultPathContext(oldPath),
          this.gitClient.resolveVaultPathContext(newPath)
        ]);
      } catch (error) {
        if (
          error instanceof GitCommandError
          && error.message === "当前笔记不在检测到的 Git 仓库中。"
        ) return false;
        throw error;
      }
      return migrateReviewStatePath(
        states,
        previousContext,
        nextContext,
        includeDescendants
      );
    }, (changed) => changed);
  }

  private mutateRestoreHistory<T>(
    mutation: (stack: UndoSnapshot[], receipts: RestoreReceipt[]) => T,
    shouldPersist: (result: T) => boolean = () => true
  ): Promise<T> {
    return this.enqueueDataOperation(async () => {
      const nextStack = clonePlainData(this.undoStack);
      const nextReceipts = clonePlainData(this.restoreReceipts);
      const result = mutation(nextStack, nextReceipts);
      if (!shouldPersist(result)) return result;
      await this.saveData(this.pluginDataSnapshot(
        this.fileReviewStates,
        this.reviewInboxCheckpoints,
        nextStack,
        nextReceipts
      ));
      this.undoStack = nextStack;
      this.restoreReceipts = nextReceipts;
      return result;
    });
  }

  savePluginData(): Promise<void> {
    return this.enqueueDataOperation(async () => {
      await this.saveData(this.pluginDataSnapshot());
    });
  }

  private async loadPluginData(): Promise<void> {
    const rawData = await this.loadData();
    const previousSchema = rawData && typeof rawData === "object"
      ? (rawData as { schemaVersion?: unknown }).schemaVersion
      : undefined;
    if (
      typeof previousSchema === "number"
      && previousSchema > CURRENT_DATA_SCHEMA_VERSION
    ) {
      const message = `Git Note History 数据来自更新版本（schema ${previousSchema}），v${this.manifest.version} 已停止加载以避免覆盖。`;
      new Notice(message, 10000);
      throw new Error(message);
    }
    const data = migratePluginData(rawData);
    const loadedSettings = data?.settings ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loadedSettings,
      reviewExcludedPaths: Array.isArray(loadedSettings.reviewExcludedPaths)
        ? loadedSettings.reviewExcludedPaths
        : DEFAULT_SETTINGS.reviewExcludedPaths
    };
    const legacy = data?.undoSnapshot;
    this.undoStack = (data?.undoStack ?? (legacy ? [legacy] : [])).map((snapshot, index) => ({
      ...snapshot,
      id: snapshot.id || `legacy-${index}-${snapshot.createdAt}`,
      scope: snapshot.scope ?? "file"
    }));
    this.restoreReceipts = data?.restoreReceipts ?? [];
    this.fileReviewStates = data.fileReviewStates ?? {};
    this.reviewInboxCheckpoints = data?.reviewInboxCheckpoints ?? {};
    if (previousSchema !== CURRENT_DATA_SCHEMA_VERSION) {
      await this.savePluginData();
    }
  }

  private reviewStateKey(context: GitRepositoryContext): string {
    return `${context.repositoryRoot}\u001f${context.repositoryRelativePath}`;
  }

  private updateInboxItemReviewed(
    context: GitRepositoryContext,
    latestCommit?: ReviewCommitSummary,
    workingFingerprint?: string,
    reviewedAt = new Date().toISOString(),
    states = this.fileReviewStates
  ): void {
    const state = this.getFileReviewStateFrom(states, context);
    markReviewInboxItemState(
      state,
      context.repositoryRelativePath,
      latestCommit,
      workingFingerprint,
      reviewedAt
    );
  }
}
