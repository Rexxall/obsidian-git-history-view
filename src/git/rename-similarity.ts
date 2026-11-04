import { diffLines } from "diff";

/** Git's default for --find-renames: at least half of the content kept. */
export const RENAME_MIN_SIMILARITY = 0.5;
/** The best candidate must beat the next one by this much, or nothing is guessed. */
export const RENAME_MIN_LEAD = 0.15;

/** Share of the larger text that both texts keep, by line, as Git scores renames. */
export function contentSimilarity(before: string, after: string): number {
  const larger = Math.max(before.length, after.length);
  if (larger === 0) return 1;
  let kept = 0;
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) kept += part.value.length;
  }
  return kept / larger;
}

/**
 * The deleted note a moved and edited note most likely came from: at least half alike,
 * and clearly ahead of every other candidate. Anything less clear returns null.
 */
export function pickSimilarRename(
  current: string,
  candidates: Array<{ path: string; content: string }>
): { path: string; similarity: number } | null {
  const scored = candidates
    .map((candidate) => ({ path: candidate.path, similarity: contentSimilarity(candidate.content, current) }))
    .sort((left, right) => right.similarity - left.similarity);
  const [best, next] = scored;
  if (!best || best.similarity < RENAME_MIN_SIMILARITY) return null;
  if (next && best.similarity - next.similarity < RENAME_MIN_LEAD) return null;
  return best;
}
