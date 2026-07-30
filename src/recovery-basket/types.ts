export type RecoveryBasketItemKind = "hunk" | "property";
export type RecoveryBasketOperation = "replace" | "insert" | "delete";

export interface RecoveryPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface RecoveryBasketSource {
  versionKey: string;
  label: string;
  commitHash?: string;
  shortHash?: string;
  historicalPath?: string;
  authoredAt?: string;
  subject?: string;
}

export interface RecoveryBasketItem {
  id: string;
  filePath: string;
  kind: RecoveryBasketItemKind;
  operation: RecoveryBasketOperation;
  label: string;
  source: RecoveryBasketSource;
  patches: RecoveryPatchHunk[];
  previewBefore: string;
  previewAfter: string;
  propertyNames?: string[];
  addedAt: string;
}

export interface RecoveryBasketState {
  schemaVersion: 1;
  id: string;
  filePath: string;
  baselineContent: string;
  baselineFingerprint: string;
  createdAt: string;
  updatedAt: string;
  items: RecoveryBasketItem[];
}

export type RecoveryBasketIssueKind =
  | "empty"
  | "stale"
  | "invalid-patch"
  | "overlap"
  | "duplicate-item"
  | "duplicate-content"
  | "property-overwrite"
  | "link-removal"
  | "item-limit"
  | "size-limit";

export interface RecoveryBasketIssue {
  kind: RecoveryBasketIssueKind;
  severity: "blocking" | "warning";
  message: string;
  itemIds?: string[];
}

export interface RecoveryBasketPlan {
  filePath: string;
  baselineContent: string;
  targetContent: string;
  baselineFingerprint: string;
  currentFingerprint?: string;
  stale: boolean;
  issues: RecoveryBasketIssue[];
  appliedItemIds: string[];
  skippedDuplicateItemIds: string[];
  addedLines: number;
  deletedLines: number;
  removedRelations: Array<{
    kind: "wikilink" | "markdown" | "embed" | "tag";
    label: string;
    target: string;
  }>;
  canApply: boolean;
}
