export type KnowledgeAssertionOutcome =
  | "holds"
  | "does-not-hold"
  | "unknown";

export interface KnowledgeAssertionBase {
  id?: string;
  label?: string;
}

export interface TextKnowledgeAssertion extends KnowledgeAssertionBase {
  kind: "text";
  operator: "contains" | "not-contains" | "equals";
  expected: string;
  caseSensitive?: boolean;
  normalizeLineEndings?: boolean;
}

export interface PropertyKnowledgeAssertion extends KnowledgeAssertionBase {
  kind: "property";
  property: string;
  operator: "exists" | "missing" | "equals" | "contains";
  expected?: unknown;
  caseSensitive?: boolean;
}

export interface RelationKnowledgeAssertion extends KnowledgeAssertionBase {
  kind: "relation";
  relation: "wikilink" | "markdown-link" | "embed" | "tag";
  operator: "exists" | "missing";
  target: string;
}

export interface StructureKnowledgeAssertion extends KnowledgeAssertionBase {
  kind: "structure";
  structure: "heading" | "task" | "code-block" | "callout" | "table" | "formula";
  operator: "exists" | "missing";
  value?: string;
}

export interface RuleKnowledgeAssertion extends KnowledgeAssertionBase {
  kind: "rule";
  ruleId: string;
  options?: Readonly<Record<string, unknown>>;
}

export interface ManualKnowledgeAssertion extends KnowledgeAssertionBase {
  kind: "manual";
  prompt: string;
}

/**
 * The non-text variants are deliberately part of the public union now so
 * callers do not have to replace the request/result contract as additional
 * deterministic evaluators are introduced.
 */
export type KnowledgeAssertion =
  | TextKnowledgeAssertion
  | PropertyKnowledgeAssertion
  | RelationKnowledgeAssertion
  | StructureKnowledgeAssertion
  | RuleKnowledgeAssertion
  | ManualKnowledgeAssertion;

export interface KnowledgeTraceVersion {
  /** Stable identity within one trace request. */
  key: string;
  label?: string;
  kind?: "commit" | "working";
  commitHash?: string;
  shortHash?: string;
  historicalPath?: string;
  authoredAt?: string;
  subject?: string;
  fingerprint?: string;
  sizeBytes?: number;
  availability?: "ready" | "unavailable";
  unavailableCode?:
    | "missing"
    | "too-large"
    | "total-limit"
    | "read-error"
    | "physical-boundary"
    | "concurrent-change";
  /**
   * Versions must be supplied from oldest to newest. Missing content remains
   * in the sequence and evaluates to unknown.
   */
  content?: string;
  unavailableReason?: string;
  manualOutcome?: KnowledgeAssertionOutcome;
  manualDetail?: string;
}

export type KnowledgeEvaluationReason =
  | "condition-met"
  | "condition-not-met"
  | "content-unavailable"
  | "invalid-frontmatter"
  | "invalid-assertion"
  | "manual-unjudged"
  | "unsupported-assertion";

export interface KnowledgeAssertionEvidence {
  start: number;
  end: number;
  excerpt: string;
}

export interface KnowledgeAssertionEvaluation {
  outcome: KnowledgeAssertionOutcome;
  reason: KnowledgeEvaluationReason;
  detail: string;
  provenance: "automatic" | "manual";
  evidence?: KnowledgeAssertionEvidence;
}

export interface KnowledgeVersionEvaluation
  extends KnowledgeAssertionEvaluation {
  index: number;
  versionKey: string;
}

export interface KnowledgeBoundary {
  beforeIndex: number;
  afterIndex: number;
  beforeVersionKey: string;
  afterVersionKey: string;
  from: Exclude<KnowledgeAssertionOutcome, "unknown">;
  to: Exclude<KnowledgeAssertionOutcome, "unknown">;
}

export interface KnowledgeTraceProbe {
  phase: "binary" | "verification";
  index: number;
  versionKey: string;
  outcome: KnowledgeAssertionOutcome;
  cached: boolean;
}

export type KnowledgeTraceConclusion =
  | "confirmed"
  | "manual-candidate"
  | "repeated-change"
  | "unknown-gap"
  | "stable"
  | "all-unknown"
  | "empty";

export interface KnowledgeTraceRequest {
  assertion: KnowledgeAssertion;
  /** Ordered oldest to newest. */
  versions: readonly KnowledgeTraceVersion[];
}

export interface KnowledgeTraceResult {
  conclusion: KnowledgeTraceConclusion;
  confirmed: boolean;
  summary: string;
  candidate: KnowledgeBoundary | null;
  boundary: KnowledgeBoundary | null;
  transitions: KnowledgeBoundary[];
  evaluations: KnowledgeVersionEvaluation[];
  unknownIndices: number[];
  probeOrder: KnowledgeTraceProbe[];
  verificationMode: "automatic" | "manual";
  stableOutcome?: Exclude<KnowledgeAssertionOutcome, "unknown">;
}
