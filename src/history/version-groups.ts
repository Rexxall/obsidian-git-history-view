import type {
  EffectiveVersionGroup,
  FileReviewState,
  GitCommitVersion
} from "../models";
import {
  milestonesForCommit
} from "./milestones";

const SESSION_WINDOW_MS = 45 * 60 * 1000;
const MAX_GROUP_CHANGE_SIZE = 160;
const AUTO_BACKUP_SUBJECT = /^(?:auto(?:matic)?[ -]?(?:backup|commit)|backup|vault backup|obsidian git backup|snapshot|sync|vault update|update notes?)\b/i;

export function contentFingerprint(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function normalizedContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function authoredTime(commit: GitCommitVersion): number {
  const value = new Date(commit.authoredAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function changeSize(commit: GitCommitVersion): number {
  return commit.addedLines + commit.deletedLines;
}

function isSpecial(commit: GitCommitVersion, state: FileReviewState): boolean {
  return ["R", "C"].includes(commit.changeType)
    || state.reviewCheckpoint?.commitHash === commit.hash
    || milestonesForCommit(state, commit.hash).length > 0;
}

function canJoin(
  newer: GitCommitVersion,
  older: GitCommitVersion,
  currentSize: number,
  state: FileReviewState,
  contents?: ReadonlyMap<string, string>
): { join: boolean; duplicate: boolean; whitespaceOnly: boolean } {
  if (isSpecial(newer, state) || isSpecial(older, state)) {
    return { join: false, duplicate: false, whitespaceOnly: false };
  }
  const newerContent = contents?.get(newer.hash);
  const olderContent = contents?.get(older.hash);
  const exactDuplicate = newerContent !== undefined && olderContent !== undefined && newerContent === olderContent;
  const whitespaceOnly = !exactDuplicate
    && newerContent !== undefined
    && olderContent !== undefined
    && normalizedContent(newerContent) === normalizedContent(olderContent);
  if (exactDuplicate || whitespaceOnly) {
    return { join: true, duplicate: exactDuplicate, whitespaceOnly };
  }
  const closeInTime = Math.abs(authoredTime(newer) - authoredTime(older)) <= SESSION_WINDOW_MS;
  const sameAuthor = newer.authorEmail === older.authorEmail || newer.authorName === older.authorName;
  const looksAutomated = AUTO_BACKUP_SUBJECT.test(newer.subject) || AUTO_BACKUP_SUBJECT.test(older.subject);
  const bothSmall = changeSize(newer) <= 24 && changeSize(older) <= 24;
  const underLimit = currentSize + changeSize(older) <= MAX_GROUP_CHANGE_SIZE;
  return {
    join: closeInTime && sameAuthor && underLimit && (looksAutomated || bothSmall),
    duplicate: false,
    whitespaceOnly: false
  };
}

function summarize(
  commits: GitCommitVersion[],
  state: FileReviewState,
  duplicateCount: number,
  whitespaceOnlyCount: number
): string {
  const representative = commits[0]!;
  const milestone = milestonesForCommit(state, representative.hash, {
    includeReviewCheckpoint: false
  })[0];
  if (milestone) return milestone.label;
  if (representative.changeType === "R") return "重命名笔记";
  if (representative.changeType === "C") return "从其他笔记复制";
  if (commits.length > 1) {
    const noise = duplicateCount + whitespaceOnlyCount;
    return noise === commits.length - 1
      ? `保留 1 个有效内容 · 折叠 ${noise} 个重复版本`
      : `合并 ${commits.length} 次连续编辑`;
  }
  if (whitespaceOnlyCount > 0) return "仅格式或空格变化";
  return representative.subject || "无提交说明";
}

export function groupEffectiveVersions(
  commits: GitCommitVersion[],
  state: FileReviewState,
  contents?: ReadonlyMap<string, string>
): EffectiveVersionGroup[] {
  const groups: EffectiveVersionGroup[] = [];
  for (const commit of commits) {
    const current = groups.at(-1);
    if (!current) {
      groups.push({
        id: commit.hash,
        commits: [commit],
        representative: commit,
        oldest: commit,
        addedLines: commit.addedLines,
        deletedLines: commit.deletedLines,
        duplicateCount: 0,
        whitespaceOnlyCount: 0,
        summary: summarize([commit], state, 0, 0),
        isMilestone: isSpecial(commit, state)
      });
      continue;
    }

    const decision = canJoin(
      current.oldest,
      commit,
      current.addedLines + current.deletedLines,
      state,
      contents
    );
    if (!decision.join) {
      groups.push({
        id: commit.hash,
        commits: [commit],
        representative: commit,
        oldest: commit,
        addedLines: commit.addedLines,
        deletedLines: commit.deletedLines,
        duplicateCount: 0,
        whitespaceOnlyCount: 0,
        summary: summarize([commit], state, 0, 0),
        isMilestone: isSpecial(commit, state)
      });
      continue;
    }

    current.commits.push(commit);
    current.oldest = commit;
    current.addedLines += commit.addedLines;
    current.deletedLines += commit.deletedLines;
    if (decision.duplicate) current.duplicateCount += 1;
    if (decision.whitespaceOnly) current.whitespaceOnlyCount += 1;
    current.summary = summarize(
      current.commits,
      state,
      current.duplicateCount,
      current.whitespaceOnlyCount
    );
  }
  return groups;
}

export function groupsSinceCheckpoint(
  groups: EffectiveVersionGroup[],
  checkpointHash?: string
): EffectiveVersionGroup[] {
  if (!checkpointHash) return [];
  const index = groups.findIndex((group) => group.commits.some((commit) => commit.hash === checkpointHash));
  return index < 0 ? groups : groups.slice(0, index);
}
