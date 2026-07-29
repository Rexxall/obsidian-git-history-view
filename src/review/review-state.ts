import type {
  FileReviewState,
  ReviewCommitSummary
} from "../models";
import { setReviewCheckpointMilestone } from "../history/milestones";

export function markReviewInboxItemState(
  state: FileReviewState,
  historicalPath: string,
  latestCommit?: ReviewCommitSummary,
  workingFingerprint?: string,
  reviewedAt = new Date().toISOString()
): void {
  if (latestCommit) {
    setReviewCheckpointMilestone(
      state,
      {
        hash: latestCommit.hash,
        historicalPath,
        authoredAt: latestCommit.authoredAt,
        subject: latestCommit.subject
      },
      reviewedAt,
      workingFingerprint
    );
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
