import type {
  GitCommitVersion,
  GitFileHistory,
  GitRepositoryContext
} from "../models";

export type HistorySignalProfile = "balanced" | "strict" | "raw";
export type HistorySignalKind =
  | "content"
  | "metadata"
  | "generated"
  | "formatting"
  | "duplicate"
  | "ignored-revision"
  | "unknown";

export interface HistorySignalRules {
  profile: HistorySignalProfile;
  ignoredProperties: string[];
  generatedProperties: string[];
  useBlameIgnoreRevs: boolean;
}

export interface HistorySignalEntry {
  commit: GitCommitVersion;
  kind: HistorySignalKind;
  reason: string;
  hiddenByProfile: boolean;
  matchedFields: string[];
}

export type HealthSeverity = "ok" | "info" | "warning" | "error";

export interface HistoryHealthDiagnostic {
  id: string;
  severity: HealthSeverity;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface GitHistoryHealthSnapshot {
  context: GitRepositoryContext;
  history: GitFileHistory;
  headHash: string;
  upstream?: string;
  ahead: number;
  behind: number;
  shallow: boolean;
  partialClone: boolean;
  objectFormat: string;
  missingObjects: string[];
  ignoreRevs: string[];
  ignoreRevsConfigured: boolean;
  currentLfsPointer: boolean;
  repositoryError?: string;
}

export interface HistoryHealthAnalysis {
  entries: HistorySignalEntry[];
  diagnostics: HistoryHealthDiagnostic[];
  signalCount: number;
  noiseCount: number;
  unknownCount: number;
}
