import path from "node:path";
import {
  FileSystemAdapter,
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
import type {
  RecoveryBasketItem,
  RecoveryBasketState
} from "./recovery-basket/types";
import {
  appendRecoveryBasketItem,
  createRecoveryBasket
} from "./recovery-basket/planner";
import {
  GIT_RECOVERY_BASKET_VIEW_TYPE,
  GitRecoveryBasketView
} from "./views/recovery-basket-view";
import { HistoricalSandboxManager } from "./sandbox/sandbox-manager";
import type {
  HistoricalSandboxInspection,
  HistoricalSandboxPatchExport,
  HistoricalSandboxRecord
} from "./sandbox/types";
import {
  GIT_HISTORICAL_SANDBOX_VIEW_TYPE,
  GitHistoricalSandboxView
} from "./views/historical-sandbox-view";
import type { LocalHistorySnapshot } from "./history-sources/local-snapshots";
import { LocalSnapshotStore } from "./history-sources/local-snapshots";
import { HistorySourceBus, providerHandoffProbe } from "./history-sources/history-source-bus";
import type {
  HistorySourceAdapter,
  HistorySourceSnapshot,
  HistorySourceVersion
} from "./history-sources/types";
import {
  GIT_HISTORY_SOURCE_VIEW_TYPE,
  GitHistorySourceView
} from "./views/history-source-view";
import {
  GIT_KNOWLEDGE_GRAPH_VIEW_TYPE,
  GitKnowledgeGraphView
} from "./views/knowledge-graph-view";
import {
  GIT_PROVENANCE_LENS_VIEW_TYPE,
  GitProvenanceLensView
} from "./views/provenance-lens-view";
import {
  buildKnowledgeGraphTimeline,
  GRAPH_TIME_MACHINE_MAX_CONTENT_BYTES,
  GRAPH_TIME_MACHINE_MAX_VERSIONS,
  type KnowledgeGraphTimeline,
  type KnowledgeGraphVersion
} from "./knowledge-graph/time-machine";
import type {
  ReviewAnnotation,
  ReviewAnnotationBlockAnchor,
  ReviewAnnotationStatus
} from "./annotations/types";
import {
  annotationBlockAnchor,
  buildMarkdownReviewPackage,
  decodeGitNotesReview,
  encodeGitNotesReview,
  MAX_REVIEW_ANNOTATIONS,
  MAX_REVIEW_ANNOTATIONS_PER_FILE
} from "./annotations/review-annotations";
import { findBlockAtLines } from "./history/markdown-blocks";
import { ReviewAnnotationModal } from "./ui/review-annotation-modal";
import {
  GIT_REVIEW_ANNOTATIONS_VIEW_TYPE,
  GitReviewAnnotationsView
} from "./views/review-annotations-view";
import {
  GIT_HISTORY_HEALTH_VIEW_TYPE,
  GitHistoryHealthView
} from "./views/history-health-view";
import type { GitHistoryHealthSnapshot } from "./health/types";

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

const MAX_ACTIVE_HISTORICAL_SANDBOXES = 8;
const MAX_TOTAL_HISTORICAL_SANDBOXES = 24;

export default class GitNoteHistoryPlugin extends Plugin {
  settings: GitNoteHistorySettings = { ...DEFAULT_SETTINGS };
  gitClient!: GitClient;
  restoreService!: RestoreService;
  private knowledgeVersionMaterializer!: KnowledgeVersionMaterializer;
  private undoStack: UndoSnapshot[] = [];
  private restoreReceipts: RestoreReceipt[] = [];
  private recoveryBaskets: Record<string, RecoveryBasketState> = {};
  private historicalSandboxes: Record<string, HistoricalSandboxRecord> = {};
  private localSnapshots: Record<string, LocalHistorySnapshot> = {};
  private reviewAnnotations: Record<string, ReviewAnnotation> = {};
  private historicalSandboxManager!: HistoricalSandboxManager;
  private fileReviewStates: Record<string, FileReviewState> = {};
  private reviewInboxCheckpoints: Record<string, ReviewInboxCheckpoint> = {};
  private dataOperationQueue: Promise<void> = Promise.resolve();
  private detailOpenGeneration = 0;
  private pendingDetailLeaf: Promise<WorkspaceLeaf> | null = null;
  private workEventOpenGeneration = 0;
  private pendingWorkEventLeaf: Promise<WorkspaceLeaf> | null = null;
  private knowledgeTraceOpenGeneration = 0;
  private pendingKnowledgeTraceLeaf: Promise<WorkspaceLeaf> | null = null;
  private recoveryBasketOpenGeneration = 0;
  private pendingRecoveryBasketLeaf: Promise<WorkspaceLeaf> | null = null;
  private historicalSandboxOpenGeneration = 0;
  private pendingHistoricalSandboxLeaf: Promise<WorkspaceLeaf> | null = null;
  private historySourceOpenGeneration = 0;
  private pendingHistorySourceLeaf: Promise<WorkspaceLeaf> | null = null;
  private knowledgeGraphOpenGeneration = 0;
  private pendingKnowledgeGraphLeaf: Promise<WorkspaceLeaf> | null = null;
  private provenanceLensOpenGeneration = 0;
  private pendingProvenanceLensLeaf: Promise<WorkspaceLeaf> | null = null;
  private reviewAnnotationsOpenGeneration = 0;
  private pendingReviewAnnotationsLeaf: Promise<WorkspaceLeaf> | null = null;
  private historyHealthOpenGeneration = 0;
  private pendingHistoryHealthLeaf: Promise<WorkspaceLeaf> | null = null;
  private readonly pendingHistoricalSandboxCreates = new Map<
    string,
    Promise<HistoricalSandboxRecord>
  >();
  private isUnloading = false;

  async onload(): Promise<void> {
    this.isUnloading = false;
    await this.loadPluginData();

    this.gitClient = new GitClient(this.app, () => this.settings);
    this.historicalSandboxManager = this.createHistoricalSandboxManager();
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
    this.registerView(
      GIT_RECOVERY_BASKET_VIEW_TYPE,
      (leaf) => new GitRecoveryBasketView(leaf, this)
    );
    this.registerView(
      GIT_HISTORICAL_SANDBOX_VIEW_TYPE,
      (leaf) => new GitHistoricalSandboxView(leaf, this)
    );
    this.registerView(
      GIT_HISTORY_SOURCE_VIEW_TYPE,
      (leaf) => new GitHistorySourceView(leaf, this)
    );
    this.registerView(
      GIT_KNOWLEDGE_GRAPH_VIEW_TYPE,
      (leaf) => new GitKnowledgeGraphView(leaf, this)
    );
    this.registerView(
      GIT_PROVENANCE_LENS_VIEW_TYPE,
      (leaf) => new GitProvenanceLensView(leaf, this)
    );
    this.registerView(
      GIT_REVIEW_ANNOTATIONS_VIEW_TYPE,
      (leaf) => new GitReviewAnnotationsView(leaf, this)
    );
    this.registerView(
      GIT_HISTORY_HEALTH_VIEW_TYPE,
      (leaf) => new GitHistoryHealthView(leaf, this)
    );

    this.addRibbonIcon("history", "打开当前笔记的 Git 历史", () => {
      void this.activateHistoryView(this.app.workspace.getActiveFile());
    });
    this.addRibbonIcon("list-checks", "打开复查收件箱", () => {
      void this.activateWorkspaceReview();
    });
    this.addRibbonIcon("boxes", "打开历史沙盒", () => {
      void this.openHistoricalSandboxManager();
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
      id: "open-current-note-recovery-basket",
      name: "打开当前笔记的恢复篮子",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) {
          void this.openRecoveryBasket(file);
        }
        return available;
      }
    });

    this.addCommand({
      id: "open-historical-sandbox-manager",
      name: "打开历史沙盒管理器",
      callback: () => void this.openHistoricalSandboxManager()
    });

    this.addCommand({
      id: "open-current-note-history-sources",
      name: "查看当前笔记的全部历史来源",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) void this.openHistorySources(file);
        return available;
      }
    });

    this.addCommand({
      id: "open-current-note-knowledge-graph-time-machine",
      name: "打开当前笔记的知识图谱时间机",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) {
          void this.openKnowledgeGraphTimeMachine(file);
        }
        return available;
      }
    });

    this.addCommand({
      id: "open-current-note-provenance-lens",
      name: "打开当前笔记的来源可信度镜头",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) {
          void this.openProvenanceLens(file);
        }
        return available;
      }
    });

    this.addCommand({
      id: "open-current-note-review-annotations",
      name: "打开当前笔记的版本批注",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) void this.openReviewAnnotations(file);
        return available;
      }
    });

    this.addCommand({
      id: "annotate-current-note-version",
      name: "批注当前笔记的工作区版本",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) void this.addWorkingVersionAnnotation(file);
        return available;
      }
    });

    this.addCommand({
      id: "annotate-selected-markdown-block",
      name: "批注当前段落或选中内容块",
      editorCheckCallback: (checking, editor, view) => {
        if (!view.file || view.file.extension !== "md") return false;
        if (!checking) {
          const selection = editor.listSelections()[0];
          const cursor = editor.getCursor();
          const startLine = selection
            ? Math.min(selection.anchor.line, selection.head.line)
            : cursor.line;
          const endLine = selection
            ? Math.max(selection.anchor.line, selection.head.line)
            : cursor.line;
          void this.addWorkingVersionAnnotation(view.file, { startLine, endLine });
        }
        return true;
      }
    });

    this.addCommand({
      id: "open-current-note-history-health",
      name: "打开当前笔记的历史健康中心",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file?.extension === "md";
        if (available && !checking && file) void this.openHistoryHealth(file);
        return available;
      }
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
        menu.addItem((item) =>
          item
            .setTitle("查看全部历史来源")
            .setIcon("layers-3")
            .onClick(() => void this.openHistorySources(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("打开知识图谱时间机")
            .setIcon("orbit")
            .onClick(() => void this.openKnowledgeGraphTimeMachine(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("打开来源可信度镜头")
            .setIcon("scan-eye")
            .onClick(() => void this.openProvenanceLens(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("打开版本批注")
            .setIcon("message-square-text")
            .onClick(() => void this.openReviewAnnotations(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("检查历史健康")
            .setIcon("activity")
            .onClick(() => void this.openHistoryHealth(file))
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
        const basketMigration = this.renameRecoveryBasketPath(
          oldPath,
          nextPath,
          includeDescendants
        );
        const localSnapshotMigration = this.renameLocalSnapshotsPath(
          oldPath,
          nextPath,
          includeDescendants
        );
        const annotationMigration = this.renameReviewAnnotationPath(
          oldPath,
          nextPath,
          includeDescendants
        );
        void (async () => {
          const [
            reviewResult,
            restoreResult,
            basketResult,
            localSnapshotResult,
            annotationResult
          ] = await Promise.allSettled([
            reviewMigration,
            restoreMigration,
            basketMigration,
            localSnapshotMigration,
            annotationMigration
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
          if (basketResult.status === "rejected") {
            const reason = basketResult.reason;
            new Notice(
              `重命名后未能迁移恢复篮子：${reason instanceof Error ? reason.message : String(reason)}`,
              9000
            );
          }
          if (localSnapshotResult.status === "rejected") {
            const reason = localSnapshotResult.reason;
            new Notice(
              `重命名后未能迁移本地快照：${reason instanceof Error ? reason.message : String(reason)}`,
              9000
            );
          }
          if (annotationResult.status === "rejected") {
            const reason = annotationResult.reason;
            new Notice(
              `重命名后未能迁移版本批注：${reason instanceof Error ? reason.message : String(reason)}`,
              9000
            );
          }
          this.refreshOpenViews();
        })();
      })
    );

    this.addSettingTab(new GitNoteHistorySettingTab(this.app, this));
    void this.showHistoricalSandboxIdentity();
  }

  private createHistoricalSandboxManager(): HistoricalSandboxManager {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("历史沙盒只支持使用本地文件系统的桌面 Vault。");
    }
    const pluginDirectory = path.resolve(
      adapter.getBasePath(),
      this.manifest.dir
        ?? path.join(this.app.vault.configDir, "plugins", this.manifest.id)
    );
    return new HistoricalSandboxManager({
      gitExecutable: this.settings.gitExecutable,
      ...(this.settings.sandboxStorageRoot
        ? { storageRoot: this.settings.sandboxStorageRoot }
        : {}),
      bundleSource: {
        pluginId: this.manifest.id,
        pluginVersion: this.manifest.version,
        directory: pluginDirectory
      }
    });
  }

  reloadHistoricalSandboxManager(): void {
    this.historicalSandboxManager = this.createHistoricalSandboxManager();
  }

  private async showHistoricalSandboxIdentity(): Promise<void> {
    const markerPath = `${this.app.vault.configDir}/.git-note-history-sandbox.json`;
    try {
      if (!(await this.app.vault.adapter.exists(markerPath))) return;
      const raw = await this.app.vault.adapter.read(markerPath);
      const record = JSON.parse(raw) as Partial<HistoricalSandboxRecord>;
      if (
        record.schemaVersion !== 1
        || (record.mode !== "capsule" && record.mode !== "editable")
        || !record.source?.shortHash
      ) return;
      const label = record.mode === "capsule"
        ? `只读时间胶囊 · ${record.source.shortHash}`
        : `可编辑历史沙盒 · ${record.source.shortHash}`;
      const status = this.addStatusBarItem();
      status.addClass("git-note-history-sandbox-status");
      status.setText(label);
      status.setAttribute(
        "title",
        "这是隔离的历史 Vault，不是当前主工作区。"
      );
      new Notice(`${label}：这是隔离的历史 Vault。`, 8000);
    } catch {
      // A malformed marker must not prevent the plugin from loading.
    }
  }

  onunload(): void {
    this.isUnloading = true;
    this.detailOpenGeneration += 1;
    this.pendingDetailLeaf = null;
    this.workEventOpenGeneration += 1;
    this.pendingWorkEventLeaf = null;
    this.knowledgeTraceOpenGeneration += 1;
    this.pendingKnowledgeTraceLeaf = null;
    this.recoveryBasketOpenGeneration += 1;
    this.pendingRecoveryBasketLeaf = null;
    this.historicalSandboxOpenGeneration += 1;
    this.pendingHistoricalSandboxLeaf = null;
    this.historySourceOpenGeneration += 1;
    this.pendingHistorySourceLeaf = null;
    this.knowledgeGraphOpenGeneration += 1;
    this.pendingKnowledgeGraphLeaf = null;
    this.provenanceLensOpenGeneration += 1;
    this.pendingProvenanceLensLeaf = null;
    this.reviewAnnotationsOpenGeneration += 1;
    this.pendingReviewAnnotationsLeaf = null;
    this.historyHealthOpenGeneration += 1;
    this.pendingHistoryHealthLeaf = null;
    this.app.workspace.detachLeavesOfType(GIT_NOTE_HISTORY_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_WORKSPACE_REVIEW_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_CONFLICT_RESOLVER_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_WORK_EVENT_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_KNOWLEDGE_TRACE_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_RECOVERY_BASKET_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_HISTORICAL_SANDBOX_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_HISTORY_SOURCE_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_KNOWLEDGE_GRAPH_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_PROVENANCE_LENS_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_REVIEW_ANNOTATIONS_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(GIT_HISTORY_HEALTH_VIEW_TYPE);
  }

  async openHistoryHealth(file: TFile): Promise<void> {
    if (this.isUnloading || file.extension !== "md") return;
    const generation = ++this.historyHealthOpenGeneration;
    const pending = this.pendingHistoryHealthLeaf;
    const leafPromise = pending ?? (async () => {
      const existing = this.app.workspace
        .getLeavesOfType(GIT_HISTORY_HEALTH_VIEW_TYPE)
        .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
      if (existing) return existing;
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: GIT_HISTORY_HEALTH_VIEW_TYPE,
        active: true
      });
      return leaf;
    })();
    if (!pending) this.pendingHistoryHealthLeaf = leafPromise;
    let leaf: WorkspaceLeaf;
    try {
      leaf = await leafPromise;
    } finally {
      if (this.pendingHistoryHealthLeaf === leafPromise) {
        this.pendingHistoryHealthLeaf = null;
      }
    }
    if (this.isUnloading) {
      leaf.detach();
      return;
    }
    if (generation !== this.historyHealthOpenGeneration) return;
    await this.app.workspace.revealLeaf(leaf);
    if (generation !== this.historyHealthOpenGeneration || this.isUnloading) return;
    if (leaf.view instanceof GitHistoryHealthView) await leaf.view.setFile(file);
  }

  async openHealthSignalComparison(
    file: TFile,
    snapshot: GitHistoryHealthSnapshot,
    index: number
  ): Promise<void> {
    const target = snapshot.history.commits[index];
    if (!target) throw new Error("找不到这条 Git revision。");
    const older = snapshot.history.commits[index + 1];
    if (older) {
      await this.openDetail({
        filePath: file.path,
        repositoryRoot: snapshot.context.repositoryRoot,
        base: { kind: "commit", commit: older },
        target: { kind: "commit", commit: target },
        initialMode: "side-by-side",
        readOnly: true,
        allowRecoveryCollection: false
      });
      return;
    }
    const targetContent = await this.gitClient.getFileContent(
      snapshot.context.repositoryRoot,
      target.hash,
      target.historicalPath
    );
    await this.openDetail({
      filePath: file.path,
      repositoryRoot: snapshot.context.repositoryRoot,
      base: { kind: "working", label: "文件尚不存在" },
      target: { kind: "commit", commit: target },
      initialMode: "side-by-side",
      readOnly: true,
      allowRecoveryCollection: false,
      baseContentOverride: "",
      targetContentOverride: targetContent
    });
  }

  async openReviewAnnotations(file: TFile): Promise<void> {
    if (this.isUnloading || file.extension !== "md") return;
    const generation = ++this.reviewAnnotationsOpenGeneration;
    const pending = this.pendingReviewAnnotationsLeaf;
    const leafPromise = pending ?? (async () => {
      const existing = this.app.workspace
        .getLeavesOfType(GIT_REVIEW_ANNOTATIONS_VIEW_TYPE)
        .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
      if (existing) return existing;
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: GIT_REVIEW_ANNOTATIONS_VIEW_TYPE,
        active: true
      });
      return leaf;
    })();
    if (!pending) this.pendingReviewAnnotationsLeaf = leafPromise;
    let leaf: WorkspaceLeaf;
    try {
      leaf = await leafPromise;
    } finally {
      if (this.pendingReviewAnnotationsLeaf === leafPromise) {
        this.pendingReviewAnnotationsLeaf = null;
      }
    }
    if (this.isUnloading) {
      leaf.detach();
      return;
    }
    if (generation !== this.reviewAnnotationsOpenGeneration) return;
    await this.app.workspace.revealLeaf(leaf);
    if (generation !== this.reviewAnnotationsOpenGeneration || this.isUnloading) return;
    if (leaf.view instanceof GitReviewAnnotationsView) await leaf.view.setFile(file);
  }

  async openProvenanceLens(file: TFile): Promise<void> {
    if (this.isUnloading || file.extension !== "md") return;
    const generation = ++this.provenanceLensOpenGeneration;
    const pending = this.pendingProvenanceLensLeaf;
    const leafPromise = pending ?? (async () => {
      const existing = this.app.workspace
        .getLeavesOfType(GIT_PROVENANCE_LENS_VIEW_TYPE)
        .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
      if (existing) return existing;
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: GIT_PROVENANCE_LENS_VIEW_TYPE,
        active: true
      });
      return leaf;
    })();
    if (!pending) this.pendingProvenanceLensLeaf = leafPromise;
    let leaf: WorkspaceLeaf;
    try {
      leaf = await leafPromise;
    } finally {
      if (this.pendingProvenanceLensLeaf === leafPromise) {
        this.pendingProvenanceLensLeaf = null;
      }
    }
    if (this.isUnloading) {
      leaf.detach();
      return;
    }
    if (generation !== this.provenanceLensOpenGeneration) return;
    await this.app.workspace.revealLeaf(leaf);
    if (generation !== this.provenanceLensOpenGeneration || this.isUnloading) return;
    if (leaf.view instanceof GitProvenanceLensView) await leaf.view.setFile(file);
  }

  async openKnowledgeGraphTimeMachine(file: TFile): Promise<void> {
    if (this.isUnloading || file.extension !== "md") return;
    const generation = ++this.knowledgeGraphOpenGeneration;
    const pending = this.pendingKnowledgeGraphLeaf;
    const leafPromise = pending ?? (async () => {
      const existing = this.app.workspace
        .getLeavesOfType(GIT_KNOWLEDGE_GRAPH_VIEW_TYPE)
        .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
      if (existing) return existing;
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: GIT_KNOWLEDGE_GRAPH_VIEW_TYPE,
        active: true
      });
      return leaf;
    })();
    if (!pending) this.pendingKnowledgeGraphLeaf = leafPromise;
    let leaf: WorkspaceLeaf;
    try {
      leaf = await leafPromise;
    } finally {
      if (this.pendingKnowledgeGraphLeaf === leafPromise) {
        this.pendingKnowledgeGraphLeaf = null;
      }
    }
    if (generation !== this.knowledgeGraphOpenGeneration || this.isUnloading) return;
    await this.app.workspace.revealLeaf(leaf);
    if (generation !== this.knowledgeGraphOpenGeneration || this.isUnloading) return;
    if (leaf.view instanceof GitKnowledgeGraphView) await leaf.view.setFile(file);
  }

  async loadKnowledgeGraphTimeline(
    file: TFile,
    signal?: AbortSignal
  ): Promise<KnowledgeGraphTimeline> {
    const history = await this.gitClient.loadFileHistory(
      file,
      GRAPH_TIME_MACHINE_MAX_VERSIONS
    );
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const commits = [...history.commits].reverse();
    const versions: KnowledgeGraphVersion[] = new Array(commits.length);
    const batchSize = 4;
    for (let start = 0; start < commits.length; start += batchSize) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const batch = commits.slice(start, start + batchSize);
      const materialized = await Promise.all(batch.map(async (commit) => {
        try {
          const content = await this.gitClient.getFileContent(
            history.context.repositoryRoot,
            commit.hash,
            commit.historicalPath
          );
          if (
            new TextEncoder().encode(content).byteLength
            > GRAPH_TIME_MACHINE_MAX_CONTENT_BYTES
          ) {
            return {
              id: commit.hash,
              label: commit.subject || commit.shortHash,
              capturedAt: commit.authoredAt,
              reference: { kind: "commit" as const, commit },
              availability: "too-large" as const,
              warning: "该版本超过 2 MB 关系分析上限。"
            };
          }
          return {
            id: commit.hash,
            label: commit.subject || commit.shortHash,
            capturedAt: commit.authoredAt,
            reference: { kind: "commit" as const, commit },
            availability: "ready" as const,
            content
          };
        } catch (error) {
          return {
            id: commit.hash,
            label: commit.subject || commit.shortHash,
            capturedAt: commit.authoredAt,
            reference: { kind: "commit" as const, commit },
            availability: "unavailable" as const,
            warning: error instanceof Error ? error.message : String(error)
          };
        }
      }));
      materialized.forEach((version, offset) => {
        versions[start + offset] = version;
      });
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const currentContent = await this.app.vault.read(file);
    versions.push({
      id: `working:${contentFingerprint(currentContent)}`,
      label: "当前工作区",
      capturedAt: new Date(file.stat.mtime).toISOString(),
      reference: { kind: "working", label: "当前工作区" },
      availability: "ready",
      content: currentContent
    });
    return buildKnowledgeGraphTimeline(versions);
  }

  async openHistorySources(file: TFile): Promise<void> {
    const generation = ++this.historySourceOpenGeneration;
    const pending = this.pendingHistorySourceLeaf;
    const leafPromise = pending ?? (async () => {
      const existing = this.app.workspace
        .getLeavesOfType(GIT_HISTORY_SOURCE_VIEW_TYPE)[0];
      if (existing) return existing;
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: GIT_HISTORY_SOURCE_VIEW_TYPE,
        active: true
      });
      return leaf;
    })();
    if (!pending) this.pendingHistorySourceLeaf = leafPromise;
    let leaf: WorkspaceLeaf;
    try {
      leaf = await leafPromise;
    } finally {
      if (this.pendingHistorySourceLeaf === leafPromise) {
        this.pendingHistorySourceLeaf = null;
      }
    }
    if (generation !== this.historySourceOpenGeneration || this.isUnloading) return;
    await this.app.workspace.revealLeaf(leaf);
    if (generation !== this.historySourceOpenGeneration || this.isUnloading) return;
    if (leaf.view instanceof GitHistorySourceView) await leaf.view.setFile(file);
  }

  async loadHistorySources(
    file: TFile,
    signal?: AbortSignal
  ): Promise<HistorySourceSnapshot> {
    const currentContent = await this.app.vault.read(file);
    const localStore = new LocalSnapshotStore(this.localSnapshots);
    const adapters: HistorySourceAdapter[] = [
      {
        descriptor: {
          kind: "workspace",
          label: "当前工作区",
          description: "当前磁盘上的笔记内容，不是长期历史。",
          access: "direct",
          confidence: "snapshot",
          capabilities: {
            listVersions: true,
            readContent: true,
            compare: false,
            restore: false,
            capture: false,
            delete: false
          },
          boundary: "每次刷新都会重新读取；不会把当前内容冒充为已提交版本。"
        },
        async probe(context) {
          return {
            descriptor: this.descriptor,
            available: true,
            status: "ready",
            summary: "作为所有比较的当前端点。",
            versions: [{
              id: "current",
              source: "workspace",
              label: "当前工作区",
              capturedAt: context.currentModifiedAt ?? new Date().toISOString(),
              contentFingerprint: contentFingerprint(context.currentContent),
              contentAvailable: true,
              comparisonAvailable: false,
              restoreAvailable: false
            }]
          };
        }
      },
      {
        descriptor: {
          kind: "git",
          label: "Git 历史",
          description: "仓库中可复核的 commit 版本和路径历史。",
          access: "direct",
          confidence: "exact",
          capabilities: {
            listVersions: true,
            readContent: true,
            compare: true,
            restore: true,
            capture: false,
            delete: false
          },
          retentionLabel: "由仓库对象和远端备份决定",
          boundary: "只执行只读 Git 查询；不会 checkout、reset、stash 或写入索引。"
        },
        probe: async () => {
          const history = await this.gitClient.loadFileHistory(file);
          return {
            descriptor: adapters[1]!.descriptor,
            available: true,
            status: history.commits.length ? "ready" : "empty",
            summary: history.commits.length
              ? `${history.commits.length} 个已读取 commit${history.hasMoreHistory ? "，仍有更早历史" : ""}。`
              : "这篇笔记还没有可读取的 Git commit。",
            versions: history.commits.map((commit) => ({
              id: commit.hash,
              source: "git" as const,
              label: commit.subject || "无提交说明",
              capturedAt: commit.authoredAt,
              detail: commit.shortHash,
              contentAvailable: true,
              comparisonAvailable: true,
              restoreAvailable: true,
              sourceReference: commit.hash
            }))
          };
        }
      },
      {
        descriptor: {
          kind: "local-snapshot",
          label: "插件本地快照",
          description: "手动保存的当前笔记副本，独立于 Git commit。",
          access: "direct",
          confidence: "snapshot",
          capabilities: {
            listVersions: true,
            readContent: true,
            compare: true,
            restore: true,
            capture: true,
            delete: true
          },
          retentionLabel: "每篇最多 12 个，总计最多 96 个 / 12 MB",
          boundary: "仅保存在插件本地数据中；不会生成 backup 笔记或污染 Vault 最新版本判断。"
        },
        async probe() {
          const records = localStore.list(file.path);
          return {
            descriptor: this.descriptor,
            available: true,
            status: records.length ? "ready" : "empty",
            summary: records.length
              ? `${records.length} 个手动快照。相同内容不会重复保存。`
              : "还没有手动快照。",
            versions: records.map((record) => ({
              id: record.id,
              source: "local-snapshot" as const,
              label: record.label,
              capturedAt: record.capturedAt,
              detail: "本地快照",
              contentFingerprint: record.contentFingerprint,
              contentAvailable: true,
              comparisonAvailable: true,
              restoreAvailable: true,
              sourceReference: record.id
            }))
          };
        }
      }
    ];
    for (const descriptor of [
      {
        kind: "file-recovery" as const,
        label: "File Recovery",
        description: "Obsidian 核心插件维护的本地恢复快照。",
        boundary: "插件不读取 File Recovery 的私有存储；请在 Obsidian 设置 → 文件恢复中查看和恢复。"
      },
      {
        kind: "sync" as const,
        label: "Obsidian Sync",
        description: "Obsidian Sync 保存的云端版本历史。",
        boundary: "插件不读取账号或 Sync 私有数据；请在文件菜单的版本历史或 Sync 历史中查看。"
      }
    ]) {
      const sourceDescriptor: HistorySourceAdapter["descriptor"] = {
        ...descriptor,
        access: "handoff",
        confidence: "provider-managed",
        capabilities: {
          listVersions: false,
          readContent: false,
          compare: false,
          restore: false,
          capture: false,
          delete: false
        },
        retentionLabel: descriptor.kind === "sync"
          ? "由当前 Sync 套餐决定"
          : "由 File Recovery 设置决定"
      };
      adapters.push({
        descriptor: sourceDescriptor,
        async probe() {
          return providerHandoffProbe(
            sourceDescriptor,
            true,
            "使用 Obsidian 原生入口查看；这里不显示未读取的版本数量。"
          );
        }
      });
    }
    return new HistorySourceBus(adapters).inspect({
      filePath: file.path,
      fileName: file.basename,
      currentContent,
      currentModifiedAt: new Date(file.stat.mtime).toISOString()
    }, signal);
  }

  captureLocalSnapshot(
    file: TFile,
    label?: string
  ): Promise<{ record: LocalHistorySnapshot; created: boolean }> {
    return this.mutateLocalSnapshots(async (store) => {
      const content = await this.app.vault.read(file);
      return store.capture({
        filePath: file.path,
        content,
        ...(label ? { label } : {}),
        sourceModifiedAt: new Date(file.stat.mtime).toISOString()
      });
    });
  }

  deleteLocalSnapshot(id: string): Promise<boolean> {
    return this.mutateLocalSnapshots((store) => Boolean(store.remove(id)));
  }

  async openHistorySourceVersion(
    file: TFile,
    version: HistorySourceVersion
  ): Promise<void> {
    if (version.source === "git") {
      const history = await this.gitClient.loadFileHistory(file);
      const commit = history.commits.find(
        (candidate) => candidate.hash === version.sourceReference
      );
      if (!commit) throw new Error("这个 Git 版本已不在当前读取窗口，请刷新后重试。");
      await this.openDetail({
        filePath: file.path,
        repositoryRoot: history.context.repositoryRoot,
        base: { kind: "commit", commit },
        target: { kind: "working", label: "当前工作区" }
      });
      return;
    }
    if (version.source !== "local-snapshot") {
      throw new Error("这个来源需要在原生界面中查看。");
    }
    const record = this.localSnapshots[
      version.sourceReference ?? version.id.replace(/^local-snapshot:/u, "")
    ];
    if (!record || record.filePath !== file.path) {
      throw new Error("本地快照已被删除或不属于当前笔记。");
    }
    const context = await this.gitClient.resolveFileContext(file);
    const pseudoHash = Array.from(record.id)
      .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
      .padEnd(40, "0")
      .slice(0, 40);
    const commit: GitCommitVersion = {
      hash: pseudoHash,
      shortHash: "本地",
      authorName: "",
      authorEmail: "",
      authoredAt: record.capturedAt,
      subject: `本地快照 · ${record.label}`,
      historicalPath: context.repositoryRelativePath,
      changeType: "M",
      addedLines: 0,
      deletedLines: 0,
      trailers: {}
    };
    await this.openDetail({
      filePath: file.path,
      repositoryRoot: context.repositoryRoot,
      base: { kind: "commit", commit },
      target: { kind: "working", label: "当前工作区" },
      initialMode: "unified",
      allowRecoveryCollection: true,
      recoverySourceOverride: {
        versionKey: `local-snapshot:${record.id}`,
        label: `本地快照 · ${record.label}`,
        historicalPath: context.repositoryRelativePath,
        authoredAt: record.capturedAt,
        subject: record.label
      },
      baseContentOverride: record.content
    });
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

  async openRecoveryBasket(file: TFile): Promise<void> {
    if (this.isUnloading || file.extension !== "md") return;
    const generation = ++this.recoveryBasketOpenGeneration;
    const leaf = await this.ensureRecoveryBasketLeaf();
    if (!leaf || this.isUnloading) {
      leaf?.detach();
      return;
    }
    if (generation !== this.recoveryBasketOpenGeneration) return;
    await this.app.workspace.revealLeaf(leaf);
    if (
      this.isUnloading
      || generation !== this.recoveryBasketOpenGeneration
    ) return;
    if (leaf.view instanceof GitRecoveryBasketView) {
      await leaf.view.setFile(file);
    }
  }

  private async ensureRecoveryBasketLeaf(): Promise<WorkspaceLeaf | null> {
    if (this.isUnloading) return null;
    const pendingLeaf = this.pendingRecoveryBasketLeaf;
    if (pendingLeaf) return pendingLeaf;
    const existing = this.app.workspace
      .getLeavesOfType(GIT_RECOVERY_BASKET_VIEW_TYPE)
      .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
    if (existing) return existing;
    const leafPromise = (async (): Promise<WorkspaceLeaf> => {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: GIT_RECOVERY_BASKET_VIEW_TYPE,
        active: true
      });
      return leaf;
    })();
    this.pendingRecoveryBasketLeaf = leafPromise;
    try {
      return await leafPromise;
    } finally {
      if (this.pendingRecoveryBasketLeaf === leafPromise) {
        this.pendingRecoveryBasketLeaf = null;
      }
    }
  }

  async openHistoricalSandboxManager(): Promise<void> {
    if (this.isUnloading) return;
    const generation = ++this.historicalSandboxOpenGeneration;
    const leaf = await this.ensureHistoricalSandboxLeaf();
    if (!leaf || this.isUnloading) {
      leaf?.detach();
      return;
    }
    if (generation !== this.historicalSandboxOpenGeneration) return;
    await this.app.workspace.revealLeaf(leaf);
    if (
      this.isUnloading
      || generation !== this.historicalSandboxOpenGeneration
    ) return;
    if (leaf.view instanceof GitHistoricalSandboxView) {
      await leaf.view.refresh();
    }
  }

  private async ensureHistoricalSandboxLeaf(): Promise<WorkspaceLeaf | null> {
    if (this.isUnloading) return null;
    const pending = this.pendingHistoricalSandboxLeaf;
    if (pending) return pending;
    const existing = this.app.workspace
      .getLeavesOfType(GIT_HISTORICAL_SANDBOX_VIEW_TYPE)
      .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit);
    if (existing) return existing;
    const leafPromise = (async (): Promise<WorkspaceLeaf> => {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: GIT_HISTORICAL_SANDBOX_VIEW_TYPE,
        active: true
      });
      return leaf;
    })();
    this.pendingHistoricalSandboxLeaf = leafPromise;
    try {
      return await leafPromise;
    } finally {
      if (this.pendingHistoricalSandboxLeaf === leafPromise) {
        this.pendingHistoricalSandboxLeaf = null;
      }
    }
  }

  async createHistoricalSandbox(
    context: GitRepositoryContext,
    commit: GitCommitVersion
  ): Promise<HistoricalSandboxRecord> {
    const key = `${context.repositoryRoot}\u0000${commit.hash}`;
    const pending = this.pendingHistoricalSandboxCreates.get(key);
    if (pending) return pending;
    const operation = this.createHistoricalSandboxOnce(context, commit);
    this.pendingHistoricalSandboxCreates.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingHistoricalSandboxCreates.get(key) === operation) {
        this.pendingHistoricalSandboxCreates.delete(key);
      }
    }
  }

  private async createHistoricalSandboxOnce(
    context: GitRepositoryContext,
    commit: GitCommitVersion
  ): Promise<HistoricalSandboxRecord> {
    const existing = Object.values(this.historicalSandboxes).find(
      (record) =>
        record.lifecycle === "active"
        && record.source.repositoryRoot === context.repositoryRoot
        && record.source.commitHash === commit.hash
    );
    if (existing) {
      await this.openHistoricalSandboxManager();
      return clonePlainData(existing);
    }
    const records = Object.values(this.historicalSandboxes);
    if (
      records.filter((record) => record.lifecycle === "active").length
      >= MAX_ACTIVE_HISTORICAL_SANDBOXES
    ) {
      throw new Error(
        `同时最多保留 ${MAX_ACTIVE_HISTORICAL_SANDBOXES} 个使用中的历史沙盒；请先归档或删除一个。`
      );
    }
    if (records.length >= MAX_TOTAL_HISTORICAL_SANDBOXES) {
      throw new Error(
        `最多管理 ${MAX_TOTAL_HISTORICAL_SANDBOXES} 个历史沙盒；请先删除不再需要的沙盒。`
      );
    }
    const record = await this.historicalSandboxManager.createCapsule({
      repositoryRoot: context.repositoryRoot,
      vaultRoot: context.vaultRoot,
      commitHash: commit.hash,
      shortHash: commit.shortHash,
      commitSubject: commit.subject,
      commitAuthoredAt: commit.authoredAt,
      anchorRepositoryPath: commit.historicalPath
    });
    if (this.isUnloading) {
      await this.historicalSandboxManager.remove(record).catch(() => undefined);
      throw new Error("插件正在卸载，已取消创建历史沙盒。");
    }
    try {
      await this.mutateHistoricalSandboxes((records) => {
        records[record.id] = clonePlainData(record);
      });
    } catch (error) {
      await this.historicalSandboxManager.remove(record).catch(() => undefined);
      throw error;
    }
    await this.openHistoricalSandboxManager();
    return clonePlainData(record);
  }

  getHistoricalSandboxes(): HistoricalSandboxRecord[] {
    return Object.values(this.historicalSandboxes)
      .map((record) => clonePlainData(record))
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt)
      );
  }

  async inspectHistoricalSandboxes(): Promise<HistoricalSandboxInspection[]> {
    const records = this.getHistoricalSandboxes();
    return Promise.all(
      records.map((record) => this.historicalSandboxManager.inspect(record))
    );
  }

  async upgradeHistoricalSandbox(id: string): Promise<HistoricalSandboxRecord> {
    const record = this.requireHistoricalSandbox(id);
    const next = await this.historicalSandboxManager.upgradeToEditable(record);
    try {
      await this.mutateHistoricalSandboxes((records) => {
        records[id] = clonePlainData(next);
      });
    } catch (error) {
      await this.historicalSandboxManager.downgradeToCapsule(next)
        .catch(() => undefined);
      throw error;
    }
    return clonePlainData(next);
  }

  async setHistoricalSandboxArchived(
    id: string,
    archived: boolean
  ): Promise<HistoricalSandboxRecord> {
    const record = this.requireHistoricalSandbox(id);
    const next = await this.historicalSandboxManager.setArchived(record, archived);
    try {
      await this.mutateHistoricalSandboxes((records) => {
        records[id] = clonePlainData(next);
      });
    } catch (error) {
      await this.historicalSandboxManager.setArchived(next, !archived)
        .catch(() => undefined);
      throw error;
    }
    return clonePlainData(next);
  }

  async exportHistoricalSandboxPatch(
    id: string
  ): Promise<HistoricalSandboxPatchExport> {
    return this.historicalSandboxManager.exportPatch(
      this.requireHistoricalSandbox(id)
    );
  }

  async openHistoricalSandboxFileComparison(
    id: string,
    repositoryPath: string
  ): Promise<void> {
    const record = this.requireHistoricalSandbox(id);
    const inspection = await this.historicalSandboxManager.inspect(record);
    if (inspection.availability !== "ready") {
      throw new Error("沙盒状态异常，不能读取实验文件。");
    }
    if (!inspection.changedPaths.includes(repositoryPath)) {
      throw new Error("这个文件不在沙盒的已跟踪改动中。");
    }
    const vaultPath = this.sandboxRepositoryPathToVaultPath(
      record,
      repositoryPath
    );
    if (!vaultPath.toLocaleLowerCase().endsWith(".md")) {
      throw new Error("恢复篮子目前只接收 Markdown 文件。");
    }
    const file = this.app.vault.getFileByPath(vaultPath);
    if (!file || file.extension !== "md") {
      throw new Error("当前 Vault 中没有对应笔记；若它是新文件，请使用“复制到当前 Vault”。");
    }
    const [sandbox, currentContent] = await Promise.all([
      this.historicalSandboxManager.readMarkdownFile(record, repositoryPath),
      this.app.vault.read(file)
    ]);
    if (sandbox.content === currentContent) {
      throw new Error("沙盒文件与当前笔记内容相同，无需带回。");
    }
    const sourceCommit: GitCommitVersion = {
      hash: record.source.commitHash,
      shortHash: record.source.shortHash,
      authorName: "",
      authorEmail: "",
      authoredAt: record.source.commitAuthoredAt || record.createdAt,
      subject: `沙盒实验 · ${record.name}`,
      historicalPath: repositoryPath,
      changeType: "M",
      addedLines: 0,
      deletedLines: 0,
      trailers: {}
    };
    await this.openDetail({
      filePath: file.path,
      repositoryRoot: record.source.repositoryRoot,
      base: { kind: "commit", commit: sourceCommit },
      target: { kind: "working", label: "当前工作区" },
      initialMode: "unified",
      readOnly: true,
      allowRecoveryCollection: true,
      recoverySourceOverride: {
        versionKey: `sandbox:${record.id}:${repositoryPath}`,
        label: `沙盒实验 · ${record.name}`,
        commitHash: record.source.commitHash,
        shortHash: record.source.shortHash,
        historicalPath: repositoryPath,
        authoredAt: record.source.commitAuthoredAt,
        subject: record.source.commitSubject
      },
      baseContentOverride: sandbox.content,
      targetContentOverride: currentContent
    });
  }

  async copyHistoricalSandboxNewNote(
    id: string,
    repositoryPath: string
  ): Promise<TFile> {
    const record = this.requireHistoricalSandbox(id);
    const inspection = await this.historicalSandboxManager.inspect(record);
    if (
      inspection.availability !== "ready"
      || !inspection.untrackedPaths.includes(repositoryPath)
    ) {
      throw new Error("这个文件不再是沙盒中的新文件，请刷新后重试。");
    }
    const vaultPath = this.sandboxRepositoryPathToVaultPath(
      record,
      repositoryPath
    );
    if (!vaultPath.toLocaleLowerCase().endsWith(".md")) {
      throw new Error("目前只允许把新的 Markdown 笔记复制回当前 Vault。");
    }
    if (this.app.vault.getAbstractFileByPath(vaultPath)) {
      throw new Error("当前 Vault 已存在同路径文件，未进行覆盖。");
    }
    const sandbox = await this.historicalSandboxManager.readMarkdownFile(
      record,
      repositoryPath
    );
    const parentPath = vaultPath.split("/").slice(0, -1).join("/");
    if (parentPath) await this.ensureVaultFolder(parentPath);
    if (this.app.vault.getAbstractFileByPath(vaultPath)) {
      throw new Error("创建目录期间目标路径出现了文件，未进行覆盖。");
    }
    const file = await this.app.vault.create(vaultPath, sandbox.content);
    await this.app.workspace.getLeaf("tab").openFile(file);
    this.refreshOpenViews();
    return file;
  }

  async removeHistoricalSandbox(id: string): Promise<void> {
    const record = this.requireHistoricalSandbox(id);
    const inspection = await this.historicalSandboxManager.inspect(record);
    if (inspection.availability !== "missing") {
      await this.historicalSandboxManager.remove(record);
    }
    await this.mutateHistoricalSandboxes((records) => {
      delete records[id];
    });
  }

  async forgetHistoricalSandboxRecord(id: string): Promise<void> {
    const record = this.requireHistoricalSandbox(id);
    const inspection = await this.historicalSandboxManager.inspect(record);
    if (
      inspection.availability !== "missing"
      && inspection.availability !== "untrusted"
    ) {
      throw new Error("沙盒目录仍可安全管理，不能只移除记录。");
    }
    await this.mutateHistoricalSandboxes((records) => {
      delete records[id];
    });
  }

  async guideFirstSandboxOpen(
    record: HistoricalSandboxRecord
  ): Promise<void> {
    await navigator.clipboard.writeText(record.vaultPath);
    window.open("obsidian://choose-vault", "_blank");
    new Notice(
      "沙盒路径已复制。请在 Vault 选择器中点“将文件夹作为 Vault 打开”，粘贴这个目录；这是 Obsidian 对首次注册文件夹的安全限制。",
      12000
    );
  }

  async openRegisteredSandbox(
    record: HistoricalSandboxRecord
  ): Promise<void> {
    const anchor = record.source.anchorRepositoryPath
      ? path.join(record.rootPath, record.source.anchorRepositoryPath)
      : record.vaultPath;
    const target = path.relative(record.vaultPath, anchor).startsWith("..")
      ? record.vaultPath
      : anchor;
    window.open(
      `obsidian://open?path=${encodeURIComponent(target)}`,
      "_blank"
    );
    const next = await this.historicalSandboxManager.markOpened(record);
    await this.mutateHistoricalSandboxes((records) => {
      records[record.id] = clonePlainData(next);
    });
  }

  private requireHistoricalSandbox(id: string): HistoricalSandboxRecord {
    const record = this.historicalSandboxes[id];
    if (!record) throw new Error("找不到这个历史沙盒记录。");
    return clonePlainData(record);
  }

  private sandboxRepositoryPathToVaultPath(
    record: HistoricalSandboxRecord,
    repositoryPath: string
  ): string {
    const normalized = repositoryPath.replace(/\\/gu, "/");
    if (
      !normalized
      || normalized.startsWith("/")
      || normalized === ".."
      || normalized.startsWith("../")
      || normalized.includes("/../")
    ) {
      throw new Error("沙盒文件路径越过了 Vault 边界。");
    }
    const vaultPrefix = record.vaultRelativePath
      .split(path.sep)
      .join("/")
      .replace(/\/+$/u, "");
    if (!vaultPrefix) return normalized;
    if (!normalized.startsWith(`${vaultPrefix}/`)) {
      throw new Error("这个沙盒文件位于当前 Vault 之外。");
    }
    return normalized.slice(vaultPrefix.length + 1);
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const segments = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) {
        throw new Error(`无法创建目录：${current} 已被同名文件占用。`);
      }
      await this.app.vault.createFolder(current);
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
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_RECOVERY_BASKET_VIEW_TYPE)) {
      if (leaf.view instanceof GitRecoveryBasketView) void leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_HISTORY_SOURCE_VIEW_TYPE)) {
      if (leaf.view instanceof GitHistorySourceView) void leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_KNOWLEDGE_GRAPH_VIEW_TYPE)) {
      if (leaf.view instanceof GitKnowledgeGraphView) void leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_PROVENANCE_LENS_VIEW_TYPE)) {
      if (leaf.view instanceof GitProvenanceLensView) void leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_REVIEW_ANNOTATIONS_VIEW_TYPE)) {
      if (leaf.view instanceof GitReviewAnnotationsView) void leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(GIT_HISTORY_HEALTH_VIEW_TYPE)) {
      if (leaf.view instanceof GitHistoryHealthView) void leaf.view.refresh();
    }
  }

  getLocalSnapshotCount(filePath?: string): number {
    return Object.values(this.localSnapshots)
      .filter((snapshot) => !filePath || snapshot.filePath === filePath)
      .length;
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
    restoreReceipts = this.restoreReceipts,
    recoveryBaskets = this.recoveryBaskets,
    historicalSandboxes = this.historicalSandboxes,
    localSnapshots = this.localSnapshots,
    reviewAnnotations = this.reviewAnnotations
  ): PersistedPluginData {
    return {
      schemaVersion: CURRENT_DATA_SCHEMA_VERSION,
      settings: this.settings,
      undoStack,
      restoreReceipts,
      recoveryBaskets,
      historicalSandboxes,
      localSnapshots,
      reviewAnnotations,
      fileReviewStates,
      reviewInboxCheckpoints
    };
  }

  getReviewAnnotations(filePath?: string): ReviewAnnotation[] {
    return Object.values(this.reviewAnnotations)
      .filter((item) => !filePath || item.filePath === filePath)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(clonePlainData);
  }

  private mutateReviewAnnotations<T>(
    mutation: (records: Record<string, ReviewAnnotation>) => T | Promise<T>,
    shouldPersist: (result: T) => boolean = () => true
  ): Promise<T> {
    return this.enqueueDataOperation(async () => {
      const next = clonePlainData(this.reviewAnnotations);
      const result = await mutation(next);
      if (!shouldPersist(result)) return result;
      await this.saveData(this.pluginDataSnapshot(
        this.fileReviewStates,
        this.reviewInboxCheckpoints,
        this.undoStack,
        this.restoreReceipts,
        this.recoveryBaskets,
        this.historicalSandboxes,
        this.localSnapshots,
        next
      ));
      this.reviewAnnotations = next;
      return result;
    });
  }

  async addWorkingVersionAnnotation(
    file: TFile,
    range?: { startLine: number; endLine: number }
  ): Promise<void> {
    try {
      const [history, content] = await Promise.all([
        this.gitClient.loadFileHistory(file),
        this.app.vault.read(file)
      ]);
      const block = range
        ? findBlockAtLines(content, range.startLine, range.endLine)
        : null;
      if (range && !block) {
        new Notice("没有找到可批注的 Markdown 内容块。");
        return;
      }
      const fingerprint = contentFingerprint(content);
      this.openReviewAnnotationEditor({
        file,
        repositoryRoot: history.context.repositoryRoot,
        historicalPath: history.context.repositoryRelativePath,
        commitHash: `working:${fingerprint}`,
        versionLabel: "当前工作区",
        ...(block ? { block: annotationBlockAnchor(block) } : {})
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  async addCommitReviewAnnotation(
    file: TFile,
    commit: GitCommitVersion,
    block?: ReviewAnnotationBlockAnchor
  ): Promise<void> {
    try {
      const context = await this.gitClient.resolveFileContext(file);
      this.openReviewAnnotationEditor({
        file,
        repositoryRoot: context.repositoryRoot,
        historicalPath: commit.historicalPath,
        commitHash: commit.hash,
        versionLabel: `${commit.shortHash} · ${commit.subject}`,
        ...(block ? { block } : {})
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private openReviewAnnotationEditor(input: {
    file: TFile;
    repositoryRoot: string;
    historicalPath: string;
    commitHash: string;
    versionLabel: string;
    block?: ReviewAnnotationBlockAnchor;
  }): void {
    const targetDescription = input.block
      ? `${input.versionLabel} · 第 ${input.block.startLine + 1}–${input.block.endLine + 1} 行`
      : `${input.versionLabel} · 整个版本`;
    new ReviewAnnotationModal(this.app, undefined, targetDescription, async (draft) => {
      if (!draft) return;
      const now = new Date().toISOString();
      const id = `annotation:${globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      await this.mutateReviewAnnotations((records) => {
        const total = Object.keys(records).length;
        const fileCount = Object.values(records)
          .filter((item) =>
            item.repositoryRoot === input.repositoryRoot
            && item.filePath === input.file.path
          ).length;
        if (total >= MAX_REVIEW_ANNOTATIONS) {
          throw new Error(`批注总数已达到 ${MAX_REVIEW_ANNOTATIONS} 条上限。`);
        }
        if (fileCount >= MAX_REVIEW_ANNOTATIONS_PER_FILE) {
          throw new Error(`这篇笔记的批注已达到 ${MAX_REVIEW_ANNOTATIONS_PER_FILE} 条上限。`);
        }
        records[id] = {
          id,
          repositoryRoot: input.repositoryRoot,
          filePath: input.file.path,
          historicalPath: input.historicalPath,
          commitHash: input.commitHash,
          versionLabel: input.versionLabel,
          target: input.block ? "block" : "version",
          ...(input.block ? { block: input.block } : {}),
          comment: draft.comment,
          status: draft.status,
          source: "local",
          createdAt: now,
          updatedAt: now
        };
      });
      new Notice("版本批注已保存。");
      await this.openReviewAnnotations(input.file);
      this.refreshOpenViews();
    }).open();
  }

  async updateReviewAnnotation(
    id: string,
    value: { comment: string; status: ReviewAnnotationStatus }
  ): Promise<void> {
    await this.mutateReviewAnnotations((records) => {
      const existing = records[id];
      if (!existing) throw new Error("找不到这条版本批注。");
      existing.comment = value.comment.trim().slice(0, 4000);
      existing.status = value.status;
      existing.updatedAt = new Date().toISOString();
    });
    this.refreshOpenViews();
  }

  async deleteReviewAnnotation(id: string): Promise<void> {
    await this.mutateReviewAnnotations((records) => {
      delete records[id];
    });
    this.refreshOpenViews();
  }

  async copyAnnotationReviewPackage(file: TFile): Promise<void> {
    const markdown = buildMarkdownReviewPackage(
      file.path,
      this.getReviewAnnotations(file.path)
    );
    await navigator.clipboard.writeText(markdown);
    new Notice("Markdown 审阅包已复制到剪贴板。");
  }

  async syncAnnotationsToGitNotes(file: TFile): Promise<void> {
    const annotations = this.getReviewAnnotations(file.path)
      .filter((item) => !item.commitHash.startsWith("working:"));
    if (annotations.length === 0) {
      new Notice("没有绑定 Git commit 的批注；工作区批注不能写入 Git notes。", 7000);
      return;
    }
    const byCommit = new Map<string, ReviewAnnotation[]>();
    for (const item of annotations) {
      const group = byCommit.get(item.commitHash) ?? [];
      group.push(item);
      byCommit.set(item.commitHash, group);
    }
    let imported = 0;
    for (const [commitHash, localItems] of byCommit) {
      const existing = await this.gitClient.readReviewGitNote(
        localItems[0]!.repositoryRoot,
        commitHash
      );
      const remoteItems = decodeGitNotesReview(existing);
      const merged = new Map<string, ReviewAnnotation>();
      for (const item of [...remoteItems, ...localItems]) {
        const previous = merged.get(item.id);
        if (!previous || item.updatedAt >= previous.updatedAt) merged.set(item.id, item);
      }
      for (const item of remoteItems) {
        if (this.reviewAnnotations[item.id]) continue;
        imported += 1;
        item.source = "git-notes";
        await this.mutateReviewAnnotations((records) => {
          records[item.id] = item;
        });
      }
      await this.gitClient.writeReviewGitNote(
        localItems[0]!.repositoryRoot,
        commitHash,
        encodeGitNotesReview(existing, [...merged.values()])
      );
    }
    new Notice(
      `已写入 ${byCommit.size} 个 commit 的专用 Git notes${imported ? `，并导入 ${imported} 条批注` : ""}。普通 git push 默认不会同步该 ref。`,
      9000
    );
    this.refreshOpenViews();
  }

  private renameReviewAnnotationPath(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean
  ): Promise<boolean> {
    return this.mutateReviewAnnotations((records) => {
      let changed = false;
      for (const item of Object.values(records)) {
        const nextPath = item.filePath === oldPath
          ? newPath
          : includeDescendants && item.filePath.startsWith(`${oldPath}/`)
            ? `${newPath}${item.filePath.slice(oldPath.length)}`
            : item.filePath;
        if (nextPath === item.filePath) continue;
        item.filePath = nextPath;
        changed = true;
      }
      return changed;
    }, (changed) => changed);
  }

  private mutateHistoricalSandboxes<T>(
    mutation: (records: Record<string, HistoricalSandboxRecord>) => T | Promise<T>
  ): Promise<T> {
    return this.enqueueDataOperation(async () => {
      const next = clonePlainData(this.historicalSandboxes);
      const result = await mutation(next);
      await this.saveData(this.pluginDataSnapshot(
        this.fileReviewStates,
        this.reviewInboxCheckpoints,
        this.undoStack,
        this.restoreReceipts,
        this.recoveryBaskets,
        next
      ));
      this.historicalSandboxes = next;
      return result;
    });
  }

  private mutateLocalSnapshots<T>(
    mutation: (
      store: LocalSnapshotStore,
      records: Record<string, LocalHistorySnapshot>
    ) => T | Promise<T>
  ): Promise<T> {
    return this.enqueueDataOperation(async () => {
      const next = clonePlainData(this.localSnapshots);
      const result = await mutation(new LocalSnapshotStore(next), next);
      await this.saveData(this.pluginDataSnapshot(
        this.fileReviewStates,
        this.reviewInboxCheckpoints,
        this.undoStack,
        this.restoreReceipts,
        this.recoveryBaskets,
        this.historicalSandboxes,
        next
      ));
      this.localSnapshots = next;
      return result;
    });
  }

  private renameLocalSnapshotsPath(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean
  ): Promise<boolean> {
    return this.mutateLocalSnapshots((_store, records) => {
      let changed = false;
      for (const record of Object.values(records)) {
        const nextPath = record.filePath === oldPath
          ? newPath
          : includeDescendants && record.filePath.startsWith(`${oldPath}/`)
            ? `${newPath}${record.filePath.slice(oldPath.length)}`
            : record.filePath;
        if (nextPath === record.filePath) continue;
        record.filePath = nextPath;
        changed = true;
      }
      return changed;
    });
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

  getRecoveryBasket(filePath: string): RecoveryBasketState | undefined {
    const basket = this.recoveryBaskets[filePath];
    return basket ? clonePlainData(basket) : undefined;
  }

  getRecoveryBasketCount(filePath?: string): number {
    if (filePath) return this.recoveryBaskets[filePath]?.items.length ?? 0;
    return Object.values(this.recoveryBaskets)
      .reduce((total, basket) => total + basket.items.length, 0);
  }

  async addRecoveryBasketItem(
    file: TFile,
    baselineContent: string,
    item: RecoveryBasketItem
  ): Promise<RecoveryBasketState> {
    return this.mutateRecoveryBaskets((baskets) => {
      const existing = baskets[file.path]
        ?? createRecoveryBasket(file.path, baselineContent);
      const next = appendRecoveryBasketItem(
        existing,
        item,
        baselineContent
      );
      baskets[file.path] = next;
      return clonePlainData(next);
    });
  }

  async removeRecoveryBasketItem(
    filePath: string,
    itemId: string
  ): Promise<boolean> {
    return this.mutateRecoveryBaskets((baskets) => {
      const basket = baskets[filePath];
      if (!basket) return false;
      const nextItems = basket.items.filter((item) => item.id !== itemId);
      if (nextItems.length === basket.items.length) return false;
      if (nextItems.length === 0) {
        delete baskets[filePath];
      } else {
        basket.items = nextItems;
        basket.updatedAt = new Date().toISOString();
      }
      return true;
    }, (changed) => changed);
  }

  async moveRecoveryBasketItem(
    filePath: string,
    itemId: string,
    direction: -1 | 1
  ): Promise<boolean> {
    return this.mutateRecoveryBaskets((baskets) => {
      const basket = baskets[filePath];
      if (!basket) return false;
      const index = basket.items.findIndex((item) => item.id === itemId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= basket.items.length) return false;
      const [item] = basket.items.splice(index, 1);
      if (!item) return false;
      basket.items.splice(target, 0, item);
      basket.updatedAt = new Date().toISOString();
      return true;
    }, (changed) => changed);
  }

  async clearRecoveryBasket(filePath: string): Promise<boolean> {
    return this.mutateRecoveryBaskets((baskets) => {
      if (!baskets[filePath]) return false;
      delete baskets[filePath];
      return true;
    }, (changed) => changed);
  }

  private mutateRecoveryBaskets<T>(
    mutation: (baskets: Record<string, RecoveryBasketState>) => T,
    shouldPersist: (result: T) => boolean = () => true
  ): Promise<T> {
    return this.enqueueDataOperation(async () => {
      const nextBaskets = clonePlainData(this.recoveryBaskets);
      const result = mutation(nextBaskets);
      if (!shouldPersist(result)) return result;
      await this.saveData(this.pluginDataSnapshot(
        this.fileReviewStates,
        this.reviewInboxCheckpoints,
        this.undoStack,
        this.restoreReceipts,
        nextBaskets
      ));
      this.recoveryBaskets = nextBaskets;
      return result;
    });
  }

  private renameRecoveryBasketPath(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean
  ): Promise<boolean> {
    return this.mutateRecoveryBaskets((baskets) => {
      let changed = false;
      const entries = Object.entries(baskets);
      for (const [key, basket] of entries) {
        const nextPath = key === oldPath
          ? newPath
          : includeDescendants && key.startsWith(`${oldPath}/`)
            ? `${newPath}${key.slice(oldPath.length)}`
            : key;
        if (nextPath === key) continue;
        delete baskets[key];
        basket.filePath = nextPath;
        for (const item of basket.items) item.filePath = nextPath;
        baskets[nextPath] = basket;
        changed = true;
      }
      return changed;
    }, (changed) => changed);
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
        : DEFAULT_SETTINGS.reviewExcludedPaths,
      historyIgnoredProperties: Array.isArray(loadedSettings.historyIgnoredProperties)
        ? loadedSettings.historyIgnoredProperties
        : DEFAULT_SETTINGS.historyIgnoredProperties,
      historyGeneratedProperties: Array.isArray(loadedSettings.historyGeneratedProperties)
        ? loadedSettings.historyGeneratedProperties
        : DEFAULT_SETTINGS.historyGeneratedProperties
    };
    const legacy = data?.undoSnapshot;
    this.undoStack = (data?.undoStack ?? (legacy ? [legacy] : [])).map((snapshot, index) => ({
      ...snapshot,
      id: snapshot.id || `legacy-${index}-${snapshot.createdAt}`,
      scope: snapshot.scope ?? "file"
    }));
    this.restoreReceipts = data?.restoreReceipts ?? [];
    this.recoveryBaskets = data?.recoveryBaskets ?? {};
    this.historicalSandboxes = data?.historicalSandboxes ?? {};
    this.localSnapshots = data?.localSnapshots ?? {};
    this.reviewAnnotations = data?.reviewAnnotations ?? {};
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
