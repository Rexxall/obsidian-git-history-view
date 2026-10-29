import type { GitCommitVersion, VersionReference } from "../models";
import { tr } from "../i18n";

export type VersionDirection = -1 | 1;
export type HistoryActivationMode = "detail" | "preview";

export function historyActivationMode(key: string): HistoryActivationMode | null {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "p") return "preview";
  if (normalizedKey === "enter" || normalizedKey === "return" || normalizedKey === "d") return "detail";
  return null;
}

export function isHistoryRowActivationKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();
  return normalizedKey === "enter"
    || normalizedKey === "return"
    || normalizedKey === "space"
    || normalizedKey === "spacebar"
    || key === " ";
}

export function versionReferenceKey(reference: VersionReference): string {
  return reference.kind === "working" ? "working" : reference.commit.hash;
}

export function buildVersionSequence(
  commits: GitCommitVersion[],
  extraReferences: VersionReference[] = []
): VersionReference[] {
  const byHash = new Map<string, GitCommitVersion>();
  for (const commit of commits) byHash.set(commit.hash, commit);
  for (const reference of extraReferences) {
    if (reference.kind === "commit") byHash.set(reference.commit.hash, reference.commit);
  }
  const chronological = [...byHash.values()].sort((left, right) => {
    const timeDifference = Date.parse(left.authoredAt) - Date.parse(right.authoredAt);
    return timeDifference === 0 ? left.hash.localeCompare(right.hash) : timeDifference;
  });
  return [
    ...chronological.map((commit): VersionReference => ({ kind: "commit", commit })),
    { kind: "working", label: tr("当前工作区", "Working copy") }
  ];
}

export function adjacentVersionReference(
  commits: GitCommitVersion[],
  current: VersionReference,
  direction: VersionDirection,
  extraReferences: VersionReference[] = []
): VersionReference | null {
  const sequence = buildVersionSequence(commits, [current, ...extraReferences]);
  const currentIndex = sequence.findIndex(
    (reference) => versionReferenceKey(reference) === versionReferenceKey(current)
  );
  if (currentIndex < 0) return null;
  return sequence[currentIndex + direction] ?? null;
}

export function adjacentDistinctVersionReference(
  commits: GitCommitVersion[],
  current: VersionReference,
  direction: VersionDirection,
  excluded: VersionReference,
  extraReferences: VersionReference[] = []
): VersionReference | null {
  const sequence = buildVersionSequence(commits, [
    current,
    excluded,
    ...extraReferences
  ]);
  const currentIndex = sequence.findIndex(
    (reference) => versionReferenceKey(reference) === versionReferenceKey(current)
  );
  if (currentIndex < 0) return null;
  const excludedKey = versionReferenceKey(excluded);
  for (
    let index = currentIndex + direction;
    index >= 0 && index < sequence.length;
    index += direction
  ) {
    const candidate = sequence[index];
    if (candidate && versionReferenceKey(candidate) !== excludedKey) return candidate;
  }
  return null;
}

export function versionReferencePosition(
  commits: GitCommitVersion[],
  current: VersionReference,
  extraReferences: VersionReference[] = []
): { current: number; total: number } {
  const sequence = buildVersionSequence(commits, [current, ...extraReferences]);
  const index = sequence.findIndex(
    (reference) => versionReferenceKey(reference) === versionReferenceKey(current)
  );
  return { current: Math.max(1, index + 1), total: sequence.length };
}
