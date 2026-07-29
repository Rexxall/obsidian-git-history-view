import type { GitCommitVersion } from "../models";

export type PathTransitionKind = "rename" | "copy";

export interface PathTransition {
  kind: PathTransitionKind;
  fromPath: string;
  toPath: string;
  commit: GitCommitVersion;
  previous: GitCommitVersion;
}

export function buildPathTransitions(
  commitsNewestFirst: GitCommitVersion[]
): PathTransition[] {
  const transitions: PathTransition[] = [];
  for (let index = 0; index < commitsNewestFirst.length - 1; index += 1) {
    const commit = commitsNewestFirst[index]!;
    const previous = commitsNewestFirst[index + 1]!;
    if (!["R", "C"].includes(commit.changeType)) continue;
    if (commit.historicalPath === previous.historicalPath) continue;
    transitions.push({
      kind: commit.changeType === "C" ? "copy" : "rename",
      fromPath: previous.historicalPath,
      toPath: commit.historicalPath,
      commit,
      previous
    });
  }
  return transitions.reverse();
}

export function compactHistoryPath(path: string, segmentCount = 2): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= segmentCount) return segments.join("/");
  return `…/${segments.slice(-segmentCount).join("/")}`;
}
