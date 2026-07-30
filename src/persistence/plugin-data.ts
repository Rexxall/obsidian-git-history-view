import type {
  FileReviewState,
  GitRepositoryContext,
  PersistedPluginData,
  ReviewCheckpoint,
  VersionBookmark,
  VersionMilestone
} from "../models";
import {
  normalizeVersionMilestones,
  projectMilestonesToBookmarks
} from "../history/milestones";
import type {
  RecoveryBasketItem,
  RecoveryBasketState,
  RecoveryPatchHunk
} from "../recovery-basket/types";
import {
  MAX_RECOVERY_BASKET_BYTES,
  MAX_RECOVERY_BASKET_ITEMS
} from "../recovery-basket/planner";
import { contentFingerprint } from "../history/version-groups";

export const CURRENT_DATA_SCHEMA_VERSION = 3;
export const REVIEW_STATE_KEY_SEPARATOR = "\u001f";

export function reviewStateKey(context: GitRepositoryContext): string {
  return [
    context.repositoryRoot,
    context.repositoryRelativePath
  ].join(REVIEW_STATE_KEY_SEPARATOR);
}

export function remapVaultPath(
  candidatePath: string,
  oldPath: string,
  newPath: string,
  includeDescendants = false
): string {
  if (!oldPath || oldPath === newPath) return candidatePath;
  if (candidatePath === oldPath) return newPath;
  if (!includeDescendants || !candidatePath.startsWith(`${oldPath}/`)) {
    return candidatePath;
  }
  return `${newPath}${candidatePath.slice(oldPath.length)}`;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function normalizedIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizePatch(value: unknown): RecoveryPatchHunk | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RecoveryPatchHunk>;
  if (
    !Number.isInteger(candidate.oldStart)
    || !Number.isInteger(candidate.oldLines)
    || !Number.isInteger(candidate.newStart)
    || !Number.isInteger(candidate.newLines)
    || (candidate.oldStart ?? -1) < 0
    || (candidate.oldLines ?? -1) < 0
    || (candidate.newStart ?? -1) < 0
    || (candidate.newLines ?? -1) < 0
    || !Array.isArray(candidate.lines)
    || candidate.lines.some((line) => typeof line !== "string")
  ) return null;
  return {
    oldStart: candidate.oldStart!,
    oldLines: candidate.oldLines!,
    newStart: candidate.newStart!,
    newLines: candidate.newLines!,
    lines: [...candidate.lines as string[]]
  };
}

function normalizeRecoveryBasketItem(value: unknown): RecoveryBasketItem | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RecoveryBasketItem>;
  const addedAt = normalizedIso(candidate.addedAt);
  const patches = Array.isArray(candidate.patches)
    ? candidate.patches.map(normalizePatch)
    : [];
  if (
    typeof candidate.id !== "string"
    || !candidate.id
    || typeof candidate.filePath !== "string"
    || !candidate.filePath
    || (candidate.kind !== "hunk" && candidate.kind !== "property")
    || !["replace", "insert", "delete"].includes(candidate.operation ?? "")
    || typeof candidate.label !== "string"
    || !candidate.label
    || !candidate.source
    || typeof candidate.source !== "object"
    || typeof candidate.source.versionKey !== "string"
    || typeof candidate.source.label !== "string"
    || typeof candidate.previewBefore !== "string"
    || typeof candidate.previewAfter !== "string"
    || !addedAt
    || patches.length === 0
    || patches.some((patch) => patch === null)
  ) return null;
  return {
    id: candidate.id,
    filePath: candidate.filePath,
    kind: candidate.kind,
    operation: candidate.operation as RecoveryBasketItem["operation"],
    label: candidate.label,
    source: { ...candidate.source },
    patches: patches as RecoveryPatchHunk[],
    previewBefore: candidate.previewBefore,
    previewAfter: candidate.previewAfter,
    ...(Array.isArray(candidate.propertyNames)
      ? {
          propertyNames: candidate.propertyNames.filter(
            (name): name is string => typeof name === "string" && Boolean(name)
          )
        }
      : {}),
    addedAt
  };
}

function normalizeRecoveryBaskets(value: unknown): Record<string, RecoveryBasketState> {
  const result: Record<string, RecoveryBasketState> = {};
  for (const basketValue of Object.values(objectRecord(value))) {
    if (!basketValue || typeof basketValue !== "object") continue;
    const candidate = basketValue as Partial<RecoveryBasketState>;
    const createdAt = normalizedIso(candidate.createdAt);
    const updatedAt = normalizedIso(candidate.updatedAt);
    if (
      candidate.schemaVersion !== 1
      || typeof candidate.id !== "string"
      || !candidate.id
      || typeof candidate.filePath !== "string"
      || !candidate.filePath
      || typeof candidate.baselineContent !== "string"
      || typeof candidate.baselineFingerprint !== "string"
      || candidate.baselineFingerprint !== contentFingerprint(candidate.baselineContent)
      || !createdAt
      || !updatedAt
      || !Array.isArray(candidate.items)
      || candidate.items.length > MAX_RECOVERY_BASKET_ITEMS
    ) continue;
    const items = candidate.items
      .map(normalizeRecoveryBasketItem)
      .filter((item): item is RecoveryBasketItem =>
        item !== null && item.filePath === candidate.filePath
      );
    const basket: RecoveryBasketState = {
      schemaVersion: 1,
      id: candidate.id,
      filePath: candidate.filePath,
      baselineContent: candidate.baselineContent,
      baselineFingerprint: candidate.baselineFingerprint,
      createdAt,
      updatedAt,
      items
    };
    if (new TextEncoder().encode(JSON.stringify(basket)).byteLength > MAX_RECOVERY_BASKET_BYTES) {
      continue;
    }
    result[basket.filePath] = basket;
  }
  return result;
}

function normalizeCheckpoint(value: unknown): ReviewCheckpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ReviewCheckpoint>;
  const reviewedAt = normalizedIso(candidate.reviewedAt);
  if (
    typeof candidate.commitHash !== "string"
    || !candidate.commitHash
    || typeof candidate.historicalPath !== "string"
    || !reviewedAt
  ) return undefined;
  return {
    commitHash: candidate.commitHash.trim(),
    historicalPath: candidate.historicalPath,
    reviewedAt,
    ...(candidate.workingFingerprint
      ? { workingFingerprint: candidate.workingFingerprint }
      : {}),
    ...(candidate.milestoneId ? { milestoneId: candidate.milestoneId } : {})
  };
}

function checkpointMilestone(
  checkpoint: ReviewCheckpoint,
  id: string,
  existing?: VersionMilestone
): VersionMilestone {
  return {
    id,
    kind: "review-checkpoint",
    label: "复查点",
    commitHash: checkpoint.commitHash,
    historicalPath: checkpoint.historicalPath,
    commitAuthoredAt: existing?.commitHash === checkpoint.commitHash
      ? existing.commitAuthoredAt
      : "",
    commitSubject: existing?.commitHash === checkpoint.commitHash
      ? existing.commitSubject
      : "",
    occurredAt: checkpoint.reviewedAt,
    createdAt: existing?.createdAt ?? checkpoint.reviewedAt,
    source: "review-checkpoint",
    ...(checkpoint.workingFingerprint
      ? { workingFingerprint: checkpoint.workingFingerprint }
      : {})
  };
}

export function normalizeFileReviewState(value: unknown): FileReviewState {
  const candidate = objectRecord(value);
  const checkpoint = normalizeCheckpoint(candidate.reviewCheckpoint);
  const legacyBookmarks = objectRecord(candidate.bookmarks);
  const milestones = normalizeVersionMilestones(
    candidate.milestones,
    legacyBookmarks
  );
  let checkpointId = typeof candidate.reviewCheckpointId === "string"
    ? candidate.reviewCheckpointId
    : checkpoint?.milestoneId;
  if (checkpoint) {
    checkpointId ||= `review-checkpoint:${checkpoint.commitHash}`;
    const existing = milestones[checkpointId];
    for (const [id, milestone] of Object.entries(milestones)) {
      if (milestone.kind === "review-checkpoint" && id !== checkpointId) {
        delete milestones[id];
      }
    }
    milestones[checkpointId] = checkpointMilestone(
      checkpoint,
      checkpointId,
      existing
    );
    checkpoint.milestoneId = checkpointId;
  } else {
    const storedCheckpoint = (
      checkpointId && milestones[checkpointId]?.kind === "review-checkpoint"
        ? milestones[checkpointId]
        : Object.values(milestones)
            .filter((milestone) => milestone.kind === "review-checkpoint")
            .sort((left, right) =>
              right.occurredAt.localeCompare(left.occurredAt)
              || right.createdAt.localeCompare(left.createdAt)
            )[0]
    );
    if (storedCheckpoint) {
      checkpointId = storedCheckpoint.id;
      for (const [id, milestone] of Object.entries(milestones)) {
        if (milestone.kind === "review-checkpoint" && id !== checkpointId) {
          delete milestones[id];
        }
      }
    } else {
      checkpointId = undefined;
    }
  }

  const state: FileReviewState = {
    bookmarks: projectMilestonesToBookmarks(milestones),
    milestones
  };
  if (typeof candidate.baselineHash === "string") state.baselineHash = candidate.baselineHash;
  if (typeof candidate.baselinePath === "string") state.baselinePath = candidate.baselinePath;
  if (typeof candidate.detailMode === "string") {
    state.detailMode = candidate.detailMode as NonNullable<FileReviewState["detailMode"]>;
  }
  if (checkpoint) state.reviewCheckpoint = checkpoint;
  else if (checkpointId) {
    const stored = milestones[checkpointId];
    if (stored) {
      state.reviewCheckpoint = {
        commitHash: stored.commitHash,
        historicalPath: stored.historicalPath,
        reviewedAt: stored.occurredAt,
        milestoneId: checkpointId,
        ...(stored.workingFingerprint
          ? { workingFingerprint: stored.workingFingerprint }
          : {})
      };
    }
  }
  if (checkpointId) state.reviewCheckpointId = checkpointId;
  if (typeof candidate.reviewedWorkingFingerprint === "string") {
    state.reviewedWorkingFingerprint = candidate.reviewedWorkingFingerprint;
  }
  if (typeof candidate.reviewedWorkingAt === "string") {
    state.reviewedWorkingAt = candidate.reviewedWorkingAt;
  }
  if (typeof candidate.snoozedUntil === "string") state.snoozedUntil = candidate.snoozedUntil;
  return state;
}

export function migratePluginData(value: unknown): PersistedPluginData {
  const candidate = objectRecord(value);
  if (
    typeof candidate.schemaVersion === "number"
    && candidate.schemaVersion > CURRENT_DATA_SCHEMA_VERSION
  ) {
    return candidate as unknown as PersistedPluginData;
  }
  const rawStates = objectRecord(candidate.fileReviewStates);
  const fileReviewStates = Object.fromEntries(
    Object.entries(rawStates).map(([key, state]) => [
      key,
      normalizeFileReviewState(state)
    ])
  );
  return {
    ...(candidate as PersistedPluginData),
    schemaVersion: CURRENT_DATA_SCHEMA_VERSION,
    fileReviewStates,
    recoveryBaskets: normalizeRecoveryBaskets(candidate.recoveryBaskets)
  };
}

function laterCheckpoint(
  left: ReviewCheckpoint | undefined,
  right: ReviewCheckpoint | undefined
): ReviewCheckpoint | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left.reviewedAt) >= Date.parse(right.reviewedAt) ? left : right;
}

function milestoneContentKey(milestone: VersionMilestone): string {
  return JSON.stringify([
    milestone.kind,
    milestone.label,
    milestone.commitHash,
    milestone.historicalPath,
    milestone.commitAuthoredAt,
    milestone.commitSubject,
    milestone.occurredAt,
    milestone.createdAt,
    milestone.source,
    milestone.note ?? "",
    milestone.workingFingerprint ?? ""
  ]);
}

function appendMilestone(
  milestones: Record<string, VersionMilestone>,
  milestone: VersionMilestone
): string {
  const preferredId = milestone.id;
  const existing = milestones[preferredId];
  if (!existing) {
    milestones[preferredId] = { ...milestone };
    return preferredId;
  }
  if (milestoneContentKey(existing) === milestoneContentKey(milestone)) {
    return preferredId;
  }
  let suffix = 2;
  let mergedId = `${preferredId}:merged:${suffix}`;
  while (milestones[mergedId]) {
    suffix += 1;
    mergedId = `${preferredId}:merged:${suffix}`;
  }
  milestones[mergedId] = { ...milestone, id: mergedId };
  return mergedId;
}

export function mergeFileReviewStates(
  sourceValue: FileReviewState,
  targetValue: FileReviewState
): FileReviewState {
  const source = normalizeFileReviewState(sourceValue);
  const target = normalizeFileReviewState(targetValue);
  const milestones: Record<string, VersionMilestone> = {};
  for (const milestone of [
    ...Object.values(source.milestones ?? {}),
    ...Object.values(target.milestones ?? {})
  ]) {
    if (milestone.kind !== "review-checkpoint") {
      appendMilestone(milestones, milestone);
    }
  }
  const selectedCheckpoint = laterCheckpoint(
    source.reviewCheckpoint,
    target.reviewCheckpoint
  );
  const reviewCheckpoint = selectedCheckpoint
    ? { ...selectedCheckpoint }
    : undefined;
  let reviewCheckpointId = reviewCheckpoint?.milestoneId;
  if (reviewCheckpoint && reviewCheckpointId) {
    const existing = [
      source.milestones?.[reviewCheckpointId],
      target.milestones?.[reviewCheckpointId]
    ].find((milestone) => milestone?.commitHash === reviewCheckpoint.commitHash);
    reviewCheckpointId = appendMilestone(
      milestones,
      checkpointMilestone(
        reviewCheckpoint,
        reviewCheckpointId,
        existing
      )
    );
    reviewCheckpoint.milestoneId = reviewCheckpointId;
  }
  return {
    ...source,
    ...target,
    bookmarks: projectMilestonesToBookmarks(milestones),
    milestones,
    ...(reviewCheckpoint ? { reviewCheckpoint } : {}),
    ...(reviewCheckpointId ? { reviewCheckpointId } : {})
  };
}

export function migrateReviewStatePath(
  states: Record<string, FileReviewState>,
  previousContext: GitRepositoryContext,
  nextContext: GitRepositoryContext,
  includeDescendants = false
): boolean {
  if (
    previousContext.repositoryRoot === nextContext.repositoryRoot
    && previousContext.repositoryRelativePath === nextContext.repositoryRelativePath
  ) return false;

  const moves = Object.entries(states).flatMap(([key, state]) => {
    const separatorIndex = key.indexOf(REVIEW_STATE_KEY_SEPARATOR);
    if (separatorIndex < 0) return [];
    const repositoryRoot = key.slice(0, separatorIndex);
    const repositoryRelativePath = key.slice(
      separatorIndex + REVIEW_STATE_KEY_SEPARATOR.length
    );
    if (repositoryRoot !== previousContext.repositoryRoot) return [];
    const remappedPath = remapVaultPath(
      repositoryRelativePath,
      previousContext.repositoryRelativePath,
      nextContext.repositoryRelativePath,
      includeDescendants
    );
    if (remappedPath === repositoryRelativePath) return [];
    return [{
      sourceKey: key,
      targetKey: [
        nextContext.repositoryRoot,
        remappedPath
      ].join(REVIEW_STATE_KEY_SEPARATOR),
      state
    }];
  });

  if (moves.length === 0) return false;
  for (const move of moves) delete states[move.sourceKey];
  for (const move of moves) {
    const target = states[move.targetKey];
    states[move.targetKey] = target
      ? mergeFileReviewStates(move.state, target)
      : move.state;
  }
  return true;
}

export function bookmarkProjection(
  state: FileReviewState
): Record<string, VersionBookmark> {
  return projectMilestonesToBookmarks(state.milestones ?? {});
}
