import { createHmac, randomBytes } from "node:crypto";
import type { GitCommittedChange } from "../models";
import type { GitZeroNumStatEntry } from "../git/parse-log";
import type {
  WorkEventChangeStatus,
  WorkEventCommit,
  WorkEventFileChange,
  WorkEventFileGroup,
  WorkEventFileGroupKey,
  WorkEventFileKind,
  WorkEventMetrics
} from "./types";

const ATTACHMENT_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "csv",
  "doc",
  "docx",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "m4a",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "svg",
  "wav",
  "webm",
  "webp",
  "xls",
  "xlsx"
]);

export interface SessionSelection {
  commits: WorkEventCommit[];
  confidence: "exact" | "heuristic";
  reason: string;
}

export interface MergeWorkEventChangesOptions {
  toVaultPath: (repositoryPath: string) => string | null;
  anchorVaultPath?: string;
  anchorRepositoryPath?: string;
  hiddenPathIdentity?: (repositoryPath: string) => string;
}

export interface MergeWorkEventChangesResult {
  changes: WorkEventFileChange[];
  hiddenRepositoryFileCount: number;
  /**
   * Opaque, request-local aliases used only to deduplicate hidden paths across
   * inferred-session commit slices. These identifiers must not enter the
   * public WorkEventSnapshot.
   */
  hiddenRepositoryFileIdentityGroups: string[][];
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function createHiddenRepositoryPathIdentity(): (repositoryPath: string) => string {
  const key = randomBytes(32);
  return (repositoryPath: string): string =>
    createHmac("sha256", key)
      .update(normalizedPath(repositoryPath), "utf8")
      .digest("hex");
}

export function countUniqueHiddenRepositoryFiles(
  identityGroups: readonly (readonly string[])[]
): number {
  const parent = new Map<string, string>();

  const find = (identity: string): string => {
    const currentParent = parent.get(identity);
    if (!currentParent || currentParent === identity) return identity;
    const root = find(currentParent);
    parent.set(identity, root);
    return root;
  };

  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (const group of identityGroups) {
    const identities = [...new Set(group.filter(Boolean))];
    const first = identities[0];
    if (!first) continue;
    for (const identity of identities) {
      if (!parent.has(identity)) parent.set(identity, identity);
      union(first, identity);
    }
  }

  return new Set([...parent.keys()].map(find)).size;
}

let configDirectories: string[] = [];

/** Set from `Vault#configDir`, so a renamed config folder is still treated as configuration. */
export function setWorkEventConfigDirectory(directory: string): void {
  const normalized = directory.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLocaleLowerCase();
  configDirectories = normalized ? [normalized] : [];
}

export function classifyWorkEventFile(repositoryPath: string): WorkEventFileKind {
  const normalized = normalizedPath(repositoryPath);
  const lower = normalized.toLocaleLowerCase();
  const isConfig = configDirectories.some((directory) =>
    lower === directory || lower.startsWith(`${directory}/`) || lower.includes(`/${directory}/`)
  );
  if (isConfig || lower.startsWith(".git/")) return "config";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".canvas")) return "canvas";
  const name = lower.split("/").at(-1) ?? lower;
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  if (ATTACHMENT_EXTENSIONS.has(extension)) return "attachment";
  return "other";
}

export function isAutomaticBackupSubject(subject: string): boolean {
  const value = subject.trim().toLocaleLowerCase();
  return /^(?:auto(?:matic)?|vault[\s_-]*backup|(?:mac|windows|linux)[\s_-]*backup|backup|自动备份|备份)(?:\s*:|\s|$)/u.test(
    value
  );
}

export function selectInferredSessionCommits(
  candidatesNewestFirst: readonly WorkEventCommit[],
  milestoneHashes: readonly string[] = [],
  maxCommits = 12,
  maxGapMinutes = 45
): SessionSelection {
  const anchor = candidatesNewestFirst[0];
  if (!anchor) {
    return { commits: [], confidence: "exact", reason: "没有可聚合的提交。" };
  }
  const selected = [anchor];
  const boundaries = new Set(milestoneHashes);
  if (
    boundaries.has(anchor.hash)
    || anchor.parentHashes.length > 1
    || !isAutomaticBackupSubject(anchor.subject)
  ) {
    return {
      commits: selected,
      confidence: "exact",
      reason: boundaries.has(anchor.hash)
        ? "命名里程碑作为会话边界。"
        : anchor.parentHashes.length > 1
          ? "合并提交不推测编辑会话。"
          : "手动提交保持为单次精确事件。"
    };
  }

  const limit = Math.max(1, Math.min(13, Math.trunc(maxCommits)));
  const maxGapMs = Math.max(1, maxGapMinutes) * 60 * 1000;
  while (selected.length < limit) {
    const newer = selected.at(-1)!;
    const older = candidatesNewestFirst[selected.length];
    if (!older) break;
    if (boundaries.has(older.hash)) break;
    if (newer.parentHashes.length !== 1 || newer.parentHashes[0] !== older.hash) break;
    if (older.parentHashes.length > 1 || !isAutomaticBackupSubject(older.subject)) break;
    const sameAuthor = newer.authorEmail && older.authorEmail
      ? newer.authorEmail.toLocaleLowerCase() === older.authorEmail.toLocaleLowerCase()
      : newer.authorName === older.authorName;
    if (!sameAuthor) break;
    const newerTime = Date.parse(newer.committedAt);
    const olderTime = Date.parse(older.committedAt);
    if (
      !Number.isFinite(newerTime)
      || !Number.isFinite(olderTime)
      || newerTime < olderTime
      || newerTime - olderTime > maxGapMs
    ) break;
    selected.push(older);
  }

  return {
    commits: selected,
    confidence: selected.length > 1 ? "heuristic" : "exact",
    reason: selected.length > 1
      ? `按第一父链、作者和 ${maxGapMinutes} 分钟间隔推测为同一编辑会话。`
      : "没有相邻的自动备份提交可安全归入同一会话。"
  };
}

function normalizedStatus(changeType: string): WorkEventChangeStatus {
  const status = changeType.charAt(0).toUpperCase();
  if (
    status === "A"
    || status === "C"
    || status === "D"
    || status === "M"
    || status === "R"
    || status === "T"
    || status === "U"
  ) return status;
  return "M";
}

export function mergeWorkEventChanges(
  statuses: readonly GitCommittedChange[],
  stats: readonly GitZeroNumStatEntry[],
  options: MergeWorkEventChangesOptions
): MergeWorkEventChangesResult {
  const statsByPath = new Map(stats.map((entry) => [entry.path, entry]));
  const changes: WorkEventFileChange[] = [];
  const hiddenRepositoryFileIdentityGroups: string[][] = [];
  const hiddenPathIdentity =
    options.hiddenPathIdentity ?? createHiddenRepositoryPathIdentity();
  const recordHiddenRepositoryFile = (
    repositoryPaths: readonly (string | undefined)[]
  ): void => {
    const identities = [
      ...new Set(
        repositoryPaths
          .filter((repositoryPath): repositoryPath is string => Boolean(repositoryPath))
          .map(hiddenPathIdentity)
      )
    ];
    if (identities.length > 0) {
      hiddenRepositoryFileIdentityGroups.push(identities);
    }
  };

  for (const status of statuses) {
    let changeStatus = normalizedStatus(status.changeType);
    let vaultPath = options.toVaultPath(status.path);
    let originalVaultPath = status.originalPath
      ? options.toVaultPath(status.originalPath)
      : null;
    if (!vaultPath && !originalVaultPath) {
      recordHiddenRepositoryFile([
        status.path,
        changeStatus === "R" ? status.originalPath : undefined
      ]);
      continue;
    }
    const stat = statsByPath.get(status.path)
      ?? (status.originalPath
        ? stats.find((entry) =>
            entry.originalPath === status.originalPath
            && entry.path === status.path
          )
        : undefined);
    let repositoryPath = status.path;
    let originalRepositoryPath = status.originalPath;
    if (!vaultPath && originalVaultPath && status.originalPath) {
      if (changeStatus === "C") {
        recordHiddenRepositoryFile([status.path]);
        continue;
      }
      // A move out of the Vault is represented as a Vault-local deletion.
      changeStatus = "D";
      repositoryPath = status.originalPath;
      vaultPath = originalVaultPath;
      originalRepositoryPath = undefined;
      originalVaultPath = null;
    } else if (vaultPath && status.originalPath && !originalVaultPath) {
      // A move or copy into the Vault is represented as a Vault-local addition.
      changeStatus = "A";
      originalRepositoryPath = undefined;
    }
    const localVaultPath = vaultPath;
    if (!localVaultPath) {
      recordHiddenRepositoryFile([status.path]);
      continue;
    }
    const entry: WorkEventFileChange = {
      status: changeStatus,
      repositoryPath,
      vaultPath: localVaultPath,
      kind: classifyWorkEventFile(repositoryPath),
      addedLines: stat?.addedLines ?? status.addedLines,
      deletedLines: stat?.deletedLines ?? status.deletedLines,
      binary: stat?.binary ?? status.binary ?? false,
      isAnchor: Boolean(
        (
          options.anchorVaultPath
          && (
            localVaultPath === options.anchorVaultPath
            || originalVaultPath === options.anchorVaultPath
          )
        )
        || (
          options.anchorRepositoryPath
          && (
            repositoryPath === options.anchorRepositoryPath
            || originalRepositoryPath === options.anchorRepositoryPath
            || status.path === options.anchorRepositoryPath
            || status.originalPath === options.anchorRepositoryPath
          )
        )
      ),
      previewStatus: "unavailable"
    };
    if (originalRepositoryPath) entry.originalRepositoryPath = originalRepositoryPath;
    if (originalVaultPath) entry.originalVaultPath = originalVaultPath;
    changes.push(entry);
  }
  return {
    changes,
    hiddenRepositoryFileCount: countUniqueHiddenRepositoryFiles(
      hiddenRepositoryFileIdentityGroups
    ),
    hiddenRepositoryFileIdentityGroups
  };
}

export function workEventMetrics(
  files: readonly WorkEventFileChange[],
  relationChanges = 0
): WorkEventMetrics {
  return files.reduce<WorkEventMetrics>(
    (metrics, file) => {
      metrics.files += 1;
      if (file.kind === "markdown" || file.kind === "canvas") metrics.notes += 1;
      if (file.kind === "attachment") metrics.attachments += 1;
      if (file.status === "A") metrics.addedFiles += 1;
      if (file.status === "D") metrics.deletedFiles += 1;
      if (file.status === "R" || file.status === "C") metrics.renamedFiles += 1;
      metrics.addedLines += file.addedLines;
      metrics.deletedLines += file.deletedLines;
      return metrics;
    },
    {
      files: 0,
      notes: 0,
      attachments: 0,
      addedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      addedLines: 0,
      deletedLines: 0,
      relationChanges
    }
  );
}

const GROUP_LABELS: Record<WorkEventFileGroupKey, string> = {
  current: "当前笔记",
  attention: "需要留意",
  notes: "其他笔记",
  attachments: "附件",
  technical: "配置与其他文件"
};

export function groupWorkEventFiles(
  files: readonly WorkEventFileChange[]
): WorkEventFileGroup[] {
  const buckets = new Map<WorkEventFileGroupKey, WorkEventFileChange[]>();
  for (const file of files) {
    const key: WorkEventFileGroupKey = file.isAnchor
      ? "current"
      : file.status === "D" || file.status === "U" || file.conflicted
        ? "attention"
        : file.kind === "markdown" || file.kind === "canvas"
          ? "notes"
          : file.kind === "attachment"
            ? "attachments"
            : "technical";
    const bucket = buckets.get(key) ?? [];
    bucket.push(file);
    buckets.set(key, bucket);
  }
  return ([
    "current",
    "attention",
    "notes",
    "attachments",
    "technical"
  ] as const).flatMap((key) => {
    const groupedFiles = buckets.get(key);
    if (!groupedFiles?.length) return [];
    return [{
      key,
      label: GROUP_LABELS[key],
      files: [...groupedFiles].sort((left, right) =>
        left.vaultPath.localeCompare(right.vaultPath, "zh-CN")
      )
    }];
  });
}

export function shouldRenderWorkEventSearch(
  fileCount: number,
  query: string,
  threshold = 20
): boolean {
  return fileCount > threshold || query.trim().length > 0;
}
