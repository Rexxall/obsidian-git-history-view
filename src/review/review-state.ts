import type {
  FileReviewState,
  ReviewCommitSummary
} from "../models";

export function markReviewInboxItemState(
  state: FileReviewState,
  historicalPath: string,
  latestCommit?: ReviewCommitSummary,
  workingFingerprint?: string,
  reviewedAt = new Date().toISOString()
): void {
  if (latestCommit) {
    state.reviewCheckpoint = {
      commitHash: latestCommit.hash,
      historicalPath,
      reviewedAt,
      ...(workingFingerprint ? { workingFingerprint } : {})
    };
  }
  if (workingFingerprint) {
    state.reviewedWorkingFingerprint = workingFingerprint;
    state.reviewedWorkingAt = reviewedAt;
  }
  delete state.snoozedUntil;
}

export function setReviewInboxItemSnoozed(
  state: FileReviewState,
  until: string | null
): void {
  if (until) state.snoozedUntil = until;
  else delete state.snoozedUntil;
}
