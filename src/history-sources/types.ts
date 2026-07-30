export type HistorySourceKind =
  | "git"
  | "workspace"
  | "local-snapshot"
  | "file-recovery"
  | "sync";

export type HistorySourceAccess =
  | "direct"
  | "handoff"
  | "unavailable";

export type HistorySourceConfidence =
  | "exact"
  | "snapshot"
  | "provider-managed";

export interface HistorySourceCapabilities {
  listVersions: boolean;
  readContent: boolean;
  compare: boolean;
  restore: boolean;
  capture: boolean;
  delete: boolean;
}

export interface HistorySourceDescriptor {
  kind: HistorySourceKind;
  label: string;
  description: string;
  access: HistorySourceAccess;
  confidence: HistorySourceConfidence;
  capabilities: HistorySourceCapabilities;
  retentionLabel?: string;
  boundary?: string;
}

export interface HistorySourceContext {
  filePath: string;
  fileName: string;
  currentContent: string;
  currentModifiedAt?: string;
}

export interface HistorySourceVersion {
  id: string;
  source: HistorySourceKind;
  label: string;
  capturedAt: string;
  detail?: string;
  contentFingerprint?: string;
  contentAvailable: boolean;
  comparisonAvailable: boolean;
  restoreAvailable: boolean;
  sourceReference?: string;
}

export interface HistorySourceProbe {
  descriptor: HistorySourceDescriptor;
  available: boolean;
  status: "ready" | "empty" | "handoff" | "unavailable" | "error";
  summary: string;
  versions: HistorySourceVersion[];
  error?: string;
}

export interface HistorySourceAdapter {
  readonly descriptor: HistorySourceDescriptor;
  probe(context: HistorySourceContext, signal?: AbortSignal): Promise<HistorySourceProbe>;
}

export interface HistorySourceSnapshot {
  filePath: string;
  capturedAt: string;
  probes: HistorySourceProbe[];
  versions: HistorySourceVersion[];
}
