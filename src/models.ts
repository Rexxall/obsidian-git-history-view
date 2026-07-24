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

export type DetailMode = "unified" | "side-by-side" | "rendered" | "preview" | "semantic" | "impact";
export type DensityMode = "compact" | "comfortable";

export interface GitConflictVersions {
  context: GitRepositoryContext;
  ancestor: string;
  ours: string;
  theirs: string;
  working: string;
}

export interface VersionBookmark {
  label: string;
  createdAt: string;
}

export interface FileReviewState {
  baselineHash?: string;
  baselinePath?: string;
  bookmarks: Record<string, VersionBookmark>;
  detailMode?: DetailMode;
  reviewCheckpoint?: ReviewCheckpoint;
}

export interface ReviewCheckpoint {
  commitHash: string;
  historicalPath: string;
  reviewedAt: string;
  workingFingerprint?: string;
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
  settings?: Partial<GitNoteHistorySettings>;
  /** @deprecated Migrated to undoStack on load. */
  undoSnapshot?: UndoSnapshot | null;
  undoStack?: UndoSnapshot[];
  restoreReceipts?: RestoreReceipt[];
  fileReviewStates?: Record<string, FileReviewState>;
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
