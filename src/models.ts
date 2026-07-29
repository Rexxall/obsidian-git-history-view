export interface GitCommitVersion {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  historicalPath: string;
  changeType: string;
  addedLines: number;
  deletedLines: number;
  trailers: Record<string, string>;
}

export interface GitFileStatus {
  raw: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitRepositoryContext {
  vaultRoot: string;
  repositoryRoot: string;
  repositoryRelativePath: string;
}

export interface GitFileHistory {
  context: GitRepositoryContext;
  branch: string;
  status: GitFileStatus;
  commits: GitCommitVersion[];
  hasMoreHistory: boolean;
  workingTreeStats: GitLineStats;
}

export interface GitLineStats {
  addedLines: number;
  deletedLines: number;
  binary?: boolean;
}

export interface GitWorkspaceChange extends GitLineStats {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitWorkspaceReview {
  context: Omit<GitRepositoryContext, "repositoryRelativePath">;
  branch: string;
  changes: GitWorkspaceChange[];
}

export interface ReviewCommitSummary {
  hash: string;
  shortHash: string;
  authoredAt: string;
  subject: string;
}

export interface GitCommittedChange extends GitLineStats {
  path: string;
  originalPath?: string;
  changeType: string;
  latestCommit?: ReviewCommitSummary;
}

export interface ReviewInboxItem extends GitLineStats {
  path: string;
  vaultPath: string;
  originalPath?: string;
  committedChange?: GitCommittedChange;
  workspaceChange?: GitWorkspaceChange;
  latestCommit?: ReviewCommitSummary;
}

export interface ReviewInboxSnapshot {
  context: Omit<GitRepositoryContext, "repositoryRelativePath">;
  branch: string;
  headHash: string;
  baselineHash?: string;
  baselineValid: boolean;
  items: ReviewInboxItem[];
}

export interface ReviewInboxCheckpoint {
  commitHash: string;
  reviewedAt: string;
}

export type DetailMode = "unified" | "side-by-side" | "rendered" | "preview" | "semantic" | "impact";
export type DensityMode = "compact" | "comfortable";

export interface GitConflictVersions {
  context: GitRepositoryContext;
  ancestor: string;
  ours: string;
  theirs: string;
  working: string;
}

export type VersionMilestoneKind =
  | "sent"
  | "submitted"
  | "confirmed"
  | "exported"
  | "important-draft"
  | "custom"
  | "review-checkpoint";

/** @deprecated Kept as a v1 data projection for downgrade compatibility. */
export interface VersionBookmark {
  label: string;
  createdAt: string;
  kind?: VersionMilestoneKind;
  note?: string;
  historicalPath?: string;
}

export interface VersionMilestoneInput {
  label: string;
  kind: VersionMilestoneKind;
  note?: string;
  occurredAt: string;
}

export interface VersionMilestone extends VersionMilestoneInput {
  id: string;
  commitHash: string;
  historicalPath: string;
  commitAuthoredAt: string;
  commitSubject: string;
  createdAt: string;
  source: "local-user" | "legacy-bookmark" | "review-checkpoint";
  workingFingerprint?: string;
}

export interface FileReviewState {
  baselineHash?: string;
  baselinePath?: string;
  milestones?: Record<string, VersionMilestone>;
  reviewCheckpointId?: string;
  /** @deprecated v1 projection; milestones is the source of truth in schema v2. */
  bookmarks: Record<string, VersionBookmark>;
  detailMode?: DetailMode;
  reviewCheckpoint?: ReviewCheckpoint;
  reviewedWorkingFingerprint?: string;
  reviewedWorkingAt?: string;
  snoozedUntil?: string;
}

export interface ReviewCheckpoint {
  commitHash: string;
  historicalPath: string;
  reviewedAt: string;
  workingFingerprint?: string;
  milestoneId?: string;
}

export interface EffectiveVersionGroup {
  id: string;
  commits: GitCommitVersion[];
  representative: GitCommitVersion;
  oldest: GitCommitVersion;
  addedLines: number;
  deletedLines: number;
  duplicateCount: number;
  whitespaceOnlyCount: number;
  summary: string;
  isMilestone: boolean;
}

export interface GitNoteHistorySettings {
  gitExecutable: string;
  repositoryRoot: string;
  maxCommits: number;
  showAuthorEmail: boolean;
  followActiveNote: boolean;
  defaultDetailMode: DetailMode;
  density: DensityMode;
  ignoreWhitespace: boolean;
  showCommitStats: boolean;
  reviewExcludedPaths: string[];
}

export interface UndoSnapshot {
  id: string;
  filePath: string;
  content: string;
  expectedCurrentContent: string;
  createdAt: string;
  label: string;
  sourceLabel?: string;
  scope?: RestoreScope;
}

export type RestoreScope = "file" | "hunk" | "paragraph" | "conflict";

export interface RestoreReceipt {
  id: string;
  filePath: string;
  label: string;
  sourceLabel?: string;
  scope: RestoreScope;
  createdAt: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  status: "applied" | "undone" | "superseded";
}

export interface RestoreOptions {
  label: string;
  sourceLabel?: string;
  scope?: RestoreScope;
  expectedCurrentContent?: string;
}

export interface PersistedPluginData {
  schemaVersion?: number;
  settings?: Partial<GitNoteHistorySettings>;
  /** @deprecated Migrated to undoStack on load. */
  undoSnapshot?: UndoSnapshot | null;
  undoStack?: UndoSnapshot[];
  restoreReceipts?: RestoreReceipt[];
  fileReviewStates?: Record<string, FileReviewState>;
  reviewInboxCheckpoints?: Record<string, ReviewInboxCheckpoint>;
}

export type VersionReference =
  | { kind: "working"; label: string }
  | { kind: "commit"; commit: GitCommitVersion };

export interface DetailRequest {
  filePath: string;
  repositoryRoot: string;
  base: VersionReference;
  target: VersionReference;
  initialMode?: DetailMode;
}
