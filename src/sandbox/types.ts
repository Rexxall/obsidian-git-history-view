export type HistoricalSandboxMode = "capsule" | "editable";
export type HistoricalSandboxLifecycle = "active" | "archived";

export interface HistoricalSandboxSource {
  repositoryRoot: string;
  vaultRoot: string;
  commitHash: string;
  shortHash: string;
  commitSubject: string;
  commitAuthoredAt: string;
  anchorRepositoryPath?: string;
}

export interface HistoricalSandboxRecord {
  schemaVersion: 1;
  id: string;
  name: string;
  rootPath: string;
  vaultPath: string;
  vaultRelativePath: string;
  mode: HistoricalSandboxMode;
  lifecycle: HistoricalSandboxLifecycle;
  source: HistoricalSandboxSource;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export interface HistoricalSandboxCreateInput {
  name?: string;
  repositoryRoot: string;
  vaultRoot: string;
  commitHash: string;
  shortHash?: string;
  commitSubject?: string;
  commitAuthoredAt?: string;
  anchorRepositoryPath?: string;
}

export interface HistoricalSandboxInspection {
  availability:
    | "ready"
    | "missing"
    | "untrusted"
    | "detached"
    | "wrong-commit";
  record: HistoricalSandboxRecord;
  headHash?: string;
  changedPaths: string[];
  untrackedPaths: string[];
  hasChanges: boolean;
}

export interface HistoricalSandboxPatchExport {
  patchPath: string;
  manifestPath: string;
  changedPaths: string[];
  untrackedPaths: string[];
  patchBytes: number;
}

export interface HistoricalSandboxBundleSource {
  pluginId: string;
  pluginVersion: string;
  directory: string;
}
