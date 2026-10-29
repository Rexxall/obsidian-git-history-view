import type {
  FileReviewState,
  GitCommitVersion,
  VersionMilestone,
  VersionMilestoneKind
} from "../models";
import { tr } from "../i18n";

/** A version bookmark as stored by schema v1; read once and turned into a milestone. */
interface LegacyBookmark {
  label?: string;
  createdAt?: string;
  kind?: VersionMilestoneKind;
  note?: string;
  historicalPath?: string;
}

export interface MilestonePreset {
  kind: VersionMilestoneKind;
  label: string;
  icon: string;
  selectable: boolean;
}

export const MILESTONE_PRESETS: readonly MilestonePreset[] = [
  { kind: "sent", label: tr("已发送", "Sent"), icon: "send", selectable: true },
  { kind: "submitted", label: tr("材料已提交", "Submitted"), icon: "badge-check", selectable: true },
  { kind: "confirmed", label: tr("已确认", "Confirmed"), icon: "circle-check-big", selectable: true },
  { kind: "exported", label: tr("已导出", "Exported"), icon: "file-down", selectable: true },
  { kind: "important-draft", label: tr("重要草稿", "Important draft"), icon: "file-pen-line", selectable: true },
  { kind: "custom", label: tr("自定义", "Custom"), icon: "bookmark", selectable: true },
  { kind: "review-checkpoint", label: tr("复查点", "Review point"), icon: "inbox", selectable: false }
] as const;

export const USER_MILESTONE_PRESETS = MILESTONE_PRESETS.filter(
  (preset) => preset.selectable
);

const PRESET_BY_KIND = new Map(
  MILESTONE_PRESETS.map((preset) => [preset.kind, preset])
);

const VALID_KINDS = new Set<VersionMilestoneKind>(
  MILESTONE_PRESETS.map((preset) => preset.kind)
);

export function milestoneKindLabel(kind: VersionMilestoneKind): string {
  return PRESET_BY_KIND.get(kind)?.label ?? tr("自定义", "Custom");
}

export function milestoneKindIcon(kind: VersionMilestoneKind): string {
  return PRESET_BY_KIND.get(kind)?.icon ?? "bookmark";
}

export function inferMilestoneKind(label: string): VersionMilestoneKind {
  const normalized = label.trim();
  if (normalized === "已发送") return "sent";
  return "custom";
}

function normalizedIso(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

export function normalizeVersionMilestone(
  id: string,
  value: unknown
): VersionMilestone | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<VersionMilestone>;
  const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
  const commitHash = typeof candidate.commitHash === "string"
    ? candidate.commitHash.trim()
    : "";
  if (!label || !commitHash) return null;
  const kind = candidate.kind && VALID_KINDS.has(candidate.kind)
    ? candidate.kind
    : inferMilestoneKind(label);
  const createdAt = normalizedIso(candidate.createdAt, new Date(0).toISOString());
  const occurredAt = normalizedIso(candidate.occurredAt, createdAt);
  const note = typeof candidate.note === "string" ? candidate.note.trim() : "";
  const workingFingerprint = typeof candidate.workingFingerprint === "string"
    ? candidate.workingFingerprint.trim()
    : "";
  return {
    id,
    kind,
    label,
    commitHash,
    historicalPath: typeof candidate.historicalPath === "string"
      ? candidate.historicalPath
      : "",
    commitAuthoredAt: typeof candidate.commitAuthoredAt === "string"
      ? candidate.commitAuthoredAt
      : "",
    commitSubject: typeof candidate.commitSubject === "string"
      ? candidate.commitSubject
      : "",
    occurredAt,
    createdAt,
    source: candidate.source === "legacy-bookmark"
      || candidate.source === "review-checkpoint"
      ? candidate.source
      : "local-user",
    ...(note ? { note } : {}),
    ...(workingFingerprint ? { workingFingerprint } : {})
  };
}

function legacyBookmarkMilestone(
  hash: string,
  value: unknown
): VersionMilestone | null {
  const bookmark = typeof value === "string"
    ? { label: value, createdAt: "" }
    : value as LegacyBookmark | null;
  const label = typeof bookmark?.label === "string" ? bookmark.label.trim() : "";
  if (!label) return null;
  const createdAt = normalizedIso(bookmark?.createdAt, new Date(0).toISOString());
  const kind = bookmark?.kind && VALID_KINDS.has(bookmark.kind)
    ? bookmark.kind
    : inferMilestoneKind(label);
  const note = typeof bookmark?.note === "string" ? bookmark.note.trim() : "";
  return {
    id: `legacy-bookmark:${hash}`,
    kind,
    label,
    commitHash: hash,
    historicalPath: typeof bookmark?.historicalPath === "string"
      ? bookmark.historicalPath
      : "",
    commitAuthoredAt: "",
    commitSubject: "",
    occurredAt: createdAt,
    createdAt,
    source: "legacy-bookmark",
    ...(note ? { note } : {})
  };
}

export function normalizeVersionMilestones(
  values: unknown,
  legacyBookmarks?: unknown
): Record<string, VersionMilestone> {
  const normalized: Record<string, VersionMilestone> = {};
  if (values && typeof values === "object") {
    for (const [id, value] of Object.entries(values)) {
      const milestone = normalizeVersionMilestone(id, value);
      if (milestone) normalized[id] = milestone;
    }
  }
  if (legacyBookmarks && typeof legacyBookmarks === "object") {
    const representedHashes = new Set(
      Object.values(normalized)
        .filter((milestone) => milestone.kind !== "review-checkpoint")
        .map((milestone) => milestone.commitHash)
    );
    for (const [hash, value] of Object.entries(legacyBookmarks)) {
      const id = `legacy-bookmark:${hash}`;
      if (normalized[id] || representedHashes.has(hash)) continue;
      const milestone = legacyBookmarkMilestone(hash, value);
      if (milestone) {
        normalized[id] = milestone;
        representedHashes.add(hash);
      }
    }
  }
  return normalized;
}

export function milestonesForCommit(
  state: Pick<FileReviewState, "milestones">,
  commitHash: string,
  options: { includeReviewCheckpoint?: boolean } = {}
): VersionMilestone[] {
  const includeReviewCheckpoint = options.includeReviewCheckpoint ?? true;
  const milestones = Object.values(state.milestones ?? {})
    .filter((milestone) =>
      milestone.commitHash === commitHash
      && (includeReviewCheckpoint || milestone.kind !== "review-checkpoint")
    )
    .sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt)
      || right.createdAt.localeCompare(left.createdAt)
      || left.id.localeCompare(right.id)
    );
  return milestones;
}

export function hasNamedMilestone(
  state: Pick<FileReviewState, "milestones">,
  commitHash: string
): boolean {
  return milestonesForCommit(state, commitHash, {
    includeReviewCheckpoint: false
  }).length > 0;
}

export function milestoneSearchText(
  state: Pick<FileReviewState, "milestones">,
  commitHash: string
): string {
  return milestonesForCommit(state, commitHash)
    .flatMap((milestone) => [
      milestone.label,
      milestoneKindLabel(milestone.kind),
      milestone.note ?? "",
      milestone.historicalPath
    ])
    .join(" ");
}

export function namedMilestoneCommits(
  commitsNewestFirst: GitCommitVersion[],
  state: Pick<FileReviewState, "milestones">
): GitCommitVersion[] {
  return commitsNewestFirst.filter((commit) => hasNamedMilestone(state, commit.hash));
}

export function namedMilestoneEvents(
  state: Pick<FileReviewState, "milestones">
): VersionMilestone[] {
  return Object.values(state.milestones ?? {})
    .filter((milestone) => milestone.kind !== "review-checkpoint")
    .sort((left, right) =>
      right.commitAuthoredAt.localeCompare(left.commitAuthoredAt)
      || right.occurredAt.localeCompare(left.occurredAt)
      || left.id.localeCompare(right.id)
    );
}

export function storedMilestoneCommitSnapshots(
  state: Pick<FileReviewState, "milestones">,
  knownCommits: readonly GitCommitVersion[] = []
): GitCommitVersion[] {
  const knownHashes = new Set(knownCommits.map((commit) => commit.hash));
  const snapshots = new Map<string, GitCommitVersion>();
  for (const milestone of namedMilestoneEvents(state)) {
    if (
      knownHashes.has(milestone.commitHash)
      || snapshots.has(milestone.commitHash)
      || !/^[0-9a-f]{7,64}$/i.test(milestone.commitHash)
      || !milestone.historicalPath
      || !milestone.commitAuthoredAt
    ) continue;
    snapshots.set(milestone.commitHash, {
      hash: milestone.commitHash,
      shortHash: milestone.commitHash.slice(0, 7),
      authorName: "",
      authorEmail: "",
      authoredAt: milestone.commitAuthoredAt,
      subject: milestone.commitSubject || milestone.label,
      historicalPath: milestone.historicalPath,
      changeType: "M",
      addedLines: 0,
      deletedLines: 0,
      trailers: {}
    });
  }
  return [...snapshots.values()].sort((left, right) =>
    right.authoredAt.localeCompare(left.authoredAt)
    || right.hash.localeCompare(left.hash)
  );
}

export function historyWithStoredMilestones(
  commitsNewestFirst: GitCommitVersion[],
  state: Pick<FileReviewState, "milestones">
): GitCommitVersion[] {
  return [
    ...commitsNewestFirst,
    ...storedMilestoneCommitSnapshots(state, commitsNewestFirst)
  ];
}

export function previousNamedMilestone(
  commitsNewestFirst: GitCommitVersion[],
  state: Pick<FileReviewState, "milestones">,
  targetHash?: string,
  kind?: VersionMilestoneKind
): { commit: GitCommitVersion; milestone: VersionMilestone } | undefined {
  const targetIndex = targetHash
    ? commitsNewestFirst.findIndex((commit) => commit.hash === targetHash)
    : -1;
  if (targetHash && targetIndex < 0) return undefined;
  const start = targetIndex >= 0 ? targetIndex + 1 : 0;
  for (const commit of commitsNewestFirst.slice(start)) {
    const milestone = milestonesForCommit(state, commit.hash, {
      includeReviewCheckpoint: false
    }).find((candidate) => !kind || candidate.kind === kind);
    if (milestone) return { commit, milestone };
  }
  return undefined;
}

export function setReviewCheckpointMilestone(
  state: FileReviewState,
  commit: Pick<GitCommitVersion, "hash" | "historicalPath" | "authoredAt" | "subject">,
  reviewedAt: string,
  workingFingerprint?: string
): void {
  const id = state.reviewCheckpointId ?? "review-checkpoint";
  const milestones = state.milestones ??= {};
  milestones[id] = {
    id,
    kind: "review-checkpoint",
    label: "复查点",
    commitHash: commit.hash,
    historicalPath: commit.historicalPath,
    commitAuthoredAt: commit.authoredAt,
    commitSubject: commit.subject,
    occurredAt: reviewedAt,
    createdAt: milestones[id]?.createdAt ?? reviewedAt,
    source: "review-checkpoint",
    ...(workingFingerprint ? { workingFingerprint } : {})
  };
  state.reviewCheckpointId = id;
  state.reviewCheckpoint = {
    commitHash: commit.hash,
    historicalPath: commit.historicalPath,
    reviewedAt,
    milestoneId: id,
    ...(workingFingerprint ? { workingFingerprint } : {})
  };
}

export function clearReviewCheckpointMilestone(state: FileReviewState): void {
  if (state.reviewCheckpointId && state.milestones) {
    delete state.milestones[state.reviewCheckpointId];
  }
  delete state.reviewCheckpointId;
  delete state.reviewCheckpoint;
}
