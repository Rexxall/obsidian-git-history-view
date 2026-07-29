import type { NoteRelationKind } from "../analysis/link-impact";

export type WorkEventAggregation = "commit" | "session";

export type WorkEventRequestSource =
  | {
      kind: "commit";
      commitHash: string;
      aggregation: WorkEventAggregation;
      milestoneHashes?: string[];
    }
  | {
      kind: "working";
    };

export interface WorkEventRequest {
  repositoryRoot?: string;
  anchorVaultPath?: string;
  anchorHistoricalPath?: string;
  source: WorkEventRequestSource;
}

export type WorkEventSourceKind = "git-commit" | "git-session" | "working";
export type WorkEventConfidence = "exact" | "heuristic" | "snapshot";
export type WorkEventChangeStatus = "A" | "C" | "D" | "M" | "R" | "T" | "U";
export type WorkEventFileKind =
  | "markdown"
  | "attachment"
  | "canvas"
  | "config"
  | "other";
export type WorkEventPreviewStatus =
  | "ready"
  | "not-text"
  | "too-large"
  | "unavailable";

export interface WorkEventCommit {
  hash: string;
  shortHash: string;
  parentHashes: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
  body: string;
}

export interface WorkEventFileChange {
  status: WorkEventChangeStatus;
  repositoryPath: string;
  originalRepositoryPath?: string;
  vaultPath: string;
  originalVaultPath?: string;
  kind: WorkEventFileKind;
  addedLines: number;
  deletedLines: number;
  binary: boolean;
  isAnchor: boolean;
  conflicted?: boolean;
  untracked?: boolean;
  netUnchanged?: boolean;
  openable?: boolean;
  beforeContent?: string;
  afterContent?: string;
  previewStatus: WorkEventPreviewStatus;
}

export interface WorkEventCommitSlice {
  commit: WorkEventCommit;
  changes: WorkEventFileChange[];
  hiddenRepositoryFileCount: number;
}

export interface WorkEventRelationDelta {
  change: "added" | "removed";
  kind: NoteRelationKind;
  target: string;
  label: string;
  sourceBeforePath?: string;
  sourceAfterPath?: string;
  eventLocal: boolean;
  currentResolvedVaultPath?: string;
}

export interface WorkEventAnalysisLimits {
  maxMarkdownFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxRelationsPerFile: number;
  maxTotalRelations: number;
}

export interface WorkEventAnalysisState {
  markdownFiles: number;
  analyzedMarkdownFiles: number;
  skippedMarkdownFiles: number;
  analyzedBytes: number;
  relationChanges: number;
  skippedRelationChanges: number;
  partial: boolean;
  limits: WorkEventAnalysisLimits;
}

export interface WorkEventSnapshot {
  id: string;
  source: WorkEventSourceKind;
  confidence: WorkEventConfidence;
  aggregation: WorkEventAggregation | "working";
  repositoryRoot: string;
  vaultRoot: string;
  branch: string;
  anchorVaultPath?: string;
  anchorHistoricalPath?: string;
  baseHash?: string;
  headHash?: string;
  startedAt?: string;
  endedAt: string;
  capturedAt: string;
  commits: WorkEventCommit[];
  commitSlices: WorkEventCommitSlice[];
  netChanges: WorkEventFileChange[];
  relationDeltas: WorkEventRelationDelta[];
  hiddenRepositoryFileCount: number;
  warnings: string[];
  analysis: WorkEventAnalysisState;
}

export interface WorkEventMetrics {
  files: number;
  notes: number;
  attachments: number;
  addedFiles: number;
  deletedFiles: number;
  renamedFiles: number;
  addedLines: number;
  deletedLines: number;
  relationChanges: number;
}

export type WorkEventFileGroupKey =
  | "current"
  | "attention"
  | "notes"
  | "attachments"
  | "technical";

export interface WorkEventFileGroup {
  key: WorkEventFileGroupKey;
  label: string;
  files: WorkEventFileChange[];
}
