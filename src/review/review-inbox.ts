import type {
  FileReviewState,
  GitCommittedChange,
  GitWorkspaceChange,
  ReviewInboxItem
} from "../models";

export type ReviewInboxFilter = "pending" | "committed" | "working" | "snoozed";
export type ReviewInboxGroupKey = "attention" | "working" | "today" | "recent" | "older";

export interface ReviewInboxGroup {
  key: ReviewInboxGroupKey;
  label: string;
  description: string;
  icon: string;
  items: ReviewInboxItem[];
}

export interface ReviewInboxPendingStatus {
  committedPending: boolean;
  workingPending: boolean;
  snoozed: boolean;
}

const GROUP_ORDER: ReviewInboxGroupKey[] = [
  "attention",
  "working",
  "today",
  "recent",
  "older"
];

const GROUP_PRESENTATION: Record<
  ReviewInboxGroupKey,
  { label: string; description: string; icon: string }
> = {
  attention: {
    label: "需要先处理",
    description: "冲突或删除会影响正常审阅",
    icon: "triangle-alert"
  },
  working: {
    label: "尚未提交",
    description: "当前工作区中的最新变化",
    icon: "file-pen-line"
  },
  today: {
    label: "今天更新",
    description: "今天进入 Git 历史的变化",
    icon: "sun"
  },
  recent: {
    label: "最近更新",
    description: "过去七天尚未确认的变化",
    icon: "calendar-days"
  },
  older: {
    label: "较早待复查",
    description: "积压超过七天的变化",
    icon: "archive"
  }
};

export function normalizeReviewExcludedPaths(values: string[]): string[] {
  return Array.from(new Set(
    values
      .flatMap((value) => value.split(/[\n,]/))
      .map((value) => value.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, ""))
      .filter(Boolean)
      .map((value) => value.toLocaleLowerCase())
  ));
}

export function isReviewPathExcluded(path: string, exclusions: string[]): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "").toLocaleLowerCase();
  return normalizeReviewExcludedPaths(exclusions).some((excluded) =>
    normalized === excluded || normalized.startsWith(`${excluded}/`)
  );
}

export function mergeReviewInboxItems(
  committedChanges: GitCommittedChange[],
  workspaceChanges: GitWorkspaceChange[],
  toVaultPath: (repositoryPath: string) => string
): ReviewInboxItem[] {
  const items = new Map<string, ReviewInboxItem>();

  for (const change of committedChanges) {
    items.set(change.path, {
      path: change.path,
      vaultPath: toVaultPath(change.path),
      ...(change.originalPath ? { originalPath: change.originalPath } : {}),
      committedChange: change,
      ...(change.latestCommit ? { latestCommit: change.latestCommit } : {}),
      addedLines: change.addedLines,
      deletedLines: change.deletedLines,
      ...(change.binary !== undefined ? { binary: change.binary } : {})
    });
  }

  for (const change of workspaceChanges) {
    const existing = items.get(change.path);
    if (existing) {
      existing.workspaceChange = change;
      existing.addedLines += change.addedLines;
      existing.deletedLines += change.deletedLines;
      if (change.binary !== undefined) existing.binary = change.binary;
      if (!existing.originalPath && change.originalPath) existing.originalPath = change.originalPath;
      continue;
    }
    items.set(change.path, {
      path: change.path,
      vaultPath: toVaultPath(change.path),
      ...(change.originalPath ? { originalPath: change.originalPath } : {}),
      workspaceChange: change,
      addedLines: change.addedLines,
      deletedLines: change.deletedLines,
      ...(change.binary !== undefined ? { binary: change.binary } : {})
    });
  }

  return Array.from(items.values());
}

export function reviewInboxItemIsAttention(item: ReviewInboxItem): boolean {
  const working = item.workspaceChange;
  const committed = item.committedChange;
  return Boolean(
    working?.conflicted
      || working?.indexStatus === "D"
      || working?.workTreeStatus === "D"
      || committed?.changeType === "D"
  );
}

export function reviewInboxItemMatchesFilter(
  item: ReviewInboxItem,
  filter: ReviewInboxFilter,
  snoozed: boolean
): boolean {
  if (filter === "snoozed") return snoozed;
  if (snoozed) return false;
  if (filter === "committed") return Boolean(item.committedChange);
  if (filter === "working") return Boolean(item.workspaceChange);
  return true;
}

export function reviewInboxPendingStatus(
  item: ReviewInboxItem,
  state: FileReviewState,
  snapshotHeadHash: string,
  workingFingerprint?: string,
  now = new Date()
): ReviewInboxPendingStatus {
  const committedPending = Boolean(
    item.committedChange
      && state.reviewCheckpoint?.commitHash
        !== (item.latestCommit?.hash ?? snapshotHeadHash)
  );
  let workingPending = Boolean(item.workspaceChange);
  if (workingFingerprint) {
    workingPending = state.reviewedWorkingFingerprint !== workingFingerprint
      && state.reviewCheckpoint?.workingFingerprint !== workingFingerprint;
  }
  const snoozed = Boolean(
    state.snoozedUntil && new Date(state.snoozedUntil) > now
  );
  return { committedPending, workingPending, snoozed };
}

export function groupReviewInboxItems(
  items: ReviewInboxItem[],
  now = new Date()
): ReviewInboxGroup[] {
  const grouped = new Map<ReviewInboxGroupKey, ReviewInboxItem[]>();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const recentStart = new Date(todayStart);
  recentStart.setDate(recentStart.getDate() - 6);

  for (const item of items) {
    let key: ReviewInboxGroupKey;
    if (reviewInboxItemIsAttention(item)) {
      key = "attention";
    } else if (item.workspaceChange) {
      key = "working";
    } else {
      const timestamp = item.latestCommit?.authoredAt
        ? new Date(item.latestCommit.authoredAt)
        : new Date(0);
      if (timestamp >= todayStart) key = "today";
      else if (timestamp >= recentStart) key = "recent";
      else key = "older";
    }
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }

  return GROUP_ORDER.flatMap((key) => {
    const groupItems = grouped.get(key);
    if (!groupItems?.length) return [];
    const presentation = GROUP_PRESENTATION[key];
    return [{
      key,
      ...presentation,
      items: groupItems.sort((left, right) =>
        (right.latestCommit?.authoredAt ?? "").localeCompare(left.latestCommit?.authoredAt ?? "")
      )
    }];
  });
}
