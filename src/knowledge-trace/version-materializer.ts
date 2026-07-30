import path from "node:path";
import type { TFile } from "obsidian";
import type { GitRepositoryContext } from "../models";
import type {
  ReadOnlyHistoricalFileInspection,
  ReadOnlyHistoricalFileObject,
  StableWorkingFileCapture
} from "../git/git-client";
import { GitClient } from "../git/git-client";
import type { KnowledgeTraceVersion } from "./types";

export const DEFAULT_KNOWLEDGE_MATERIALIZATION_LIMITS = {
  maxVersions: 240,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxConcurrency: 4
} as const;

export interface KnowledgeMaterializationLimits {
  maxVersions: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxConcurrency: number;
}

export interface KnowledgeMaterializationOptions {
  maxVersions?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxConcurrency?: number;
  includeWorking?: boolean;
  signal?: AbortSignal;
}

export interface KnowledgeWorkingSnapshot {
  versionKey: string;
  filePath: string;
  repositoryPath: string;
  capturedAt: string;
  branch: string;
  headHash: string;
  status: string;
  content?: string;
  fingerprint?: string;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  sizeBytes: number | null;
  availability: "ready" | "unavailable";
  unavailableCode?: KnowledgeVersionUnavailableCode;
  unavailableReason?: string;
  staleAtCompletion: boolean;
}

export interface KnowledgeVersionMaterialization {
  context: GitRepositoryContext;
  filePath: string;
  branch: string;
  headHash: string;
  capturedAt: string;
  /** Git ancestry order, oldest to newest. The working snapshot is last. */
  samples: KnowledgeTraceVersion[];
  /** Alias for consumers that pass the result directly to the trace engine. */
  versions: KnowledgeTraceVersion[];
  workingSnapshot?: KnowledgeWorkingSnapshot;
  limits: KnowledgeMaterializationLimits;
  hasMoreHistory: boolean;
  truncated: boolean;
  materializedBytes: number;
  warnings: string[];
}

export type KnowledgeVersionUnavailableCode =
  | "missing"
  | "too-large"
  | "total-limit"
  | "read-error"
  | "physical-boundary"
  | "concurrent-change";

interface HistoricalPlan {
  index: number;
  commitHash: string;
  historicalPath: string;
  inspection:
    | ReadOnlyHistoricalFileInspection
    | { availability: "physical-boundary"; sizeBytes: null };
  allowedByTotalLimit: boolean;
}

type PlannedHistoricalObject =
  | ReadOnlyHistoricalFileObject
  | { availability: "physical-boundary"; sizeBytes: null };

const UNAVAILABLE_REASON: Record<KnowledgeVersionUnavailableCode, string> = {
  missing: "这个版本中找不到可读取的笔记内容。",
  "too-large": "这个版本超过单文件读取上限。",
  "total-limit": "本次追踪已达到总读取量上限。",
  "read-error": "Git 对象无法读取。",
  "physical-boundary": "当前文件的物理路径位于 Vault 之外。",
  "concurrent-change": "采样期间笔记或 Git 状态发生了变化。"
};

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function resolveLimits(
  options: KnowledgeMaterializationOptions
): KnowledgeMaterializationLimits {
  return {
    maxVersions: clampInteger(
      options.maxVersions,
      DEFAULT_KNOWLEDGE_MATERIALIZATION_LIMITS.maxVersions,
      1,
      1000
    ),
    maxFileBytes: clampInteger(
      options.maxFileBytes,
      DEFAULT_KNOWLEDGE_MATERIALIZATION_LIMITS.maxFileBytes,
      1,
      4 * 1024 * 1024
    ),
    maxTotalBytes: clampInteger(
      options.maxTotalBytes,
      DEFAULT_KNOWLEDGE_MATERIALIZATION_LIMITS.maxTotalBytes,
      1,
      32 * 1024 * 1024
    ),
    maxConcurrency: clampInteger(
      options.maxConcurrency,
      DEFAULT_KNOWLEDGE_MATERIALIZATION_LIMITS.maxConcurrency,
      1,
      8
    )
  };
}

function unavailableVersion(
  base: Omit<KnowledgeTraceVersion, "content" | "unavailableReason">,
  code: KnowledgeVersionUnavailableCode
): KnowledgeTraceVersion {
  return {
    ...base,
    availability: "unavailable",
    unavailableCode: code,
    unavailableReason: UNAVAILABLE_REASON[code]
  };
}

function workingUnavailableCode(
  capture: Exclude<StableWorkingFileCapture, { availability: "ready" }>
): KnowledgeVersionUnavailableCode {
  return capture.availability;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await mapper(value, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, values.length)) },
      () => worker()
    )
  );
  return results;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("知识追踪已取消。");
}

function isHistoricalPathInsideVault(
  context: GitRepositoryContext,
  historicalPath: string
): boolean {
  const resolved = path.resolve(context.repositoryRoot, historicalPath);
  const relative = path.relative(context.vaultRoot, resolved);
  return relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function toKnowledgeTraceVersions(
  materialization: KnowledgeVersionMaterialization
): KnowledgeTraceVersion[] {
  return materialization.samples.map((sample) => ({ ...sample }));
}

/**
 * Materializes immutable Git objects plus one frozen working copy. It never
 * checks out a revision, moves HEAD, creates bisect state, stages, or writes.
 */
export class KnowledgeVersionMaterializer {
  constructor(private readonly gitClient: GitClient) {}

  async materialize(
    file: TFile,
    options: KnowledgeMaterializationOptions = {}
  ): Promise<KnowledgeVersionMaterialization> {
    const limits = resolveLimits(options);
    const includeWorking = options.includeWorking !== false;
    const historicalLimit = Math.max(0, limits.maxVersions - (includeWorking ? 1 : 0));
    const signal = options.signal;
    throwIfAborted(signal);

    const history = await this.gitClient.loadFirstParentFileHistory(
      file,
      historicalLimit
    );
    throwIfAborted(signal);

    let workingSnapshot: KnowledgeWorkingSnapshot | undefined;
    let workingVersion: KnowledgeTraceVersion | undefined;
    let materializedBytes = 0;
    const warnings: string[] = [];
    const capturedAt = new Date().toISOString();
    let exactRenameStillMatches = !includeWorking;

    if (includeWorking) {
      const capture = await this.gitClient.captureStableWorkingFile(
        file,
        Math.min(limits.maxFileBytes, limits.maxTotalBytes)
      );
      const sameHistoryState =
        capture.headHash === history.headHash
        && capture.branch === history.branch
        && capture.status === history.status
        && (
          !history.anchorWorkingFingerprint
          || (
            capture.availability === "ready"
            && capture.beforeFingerprint === history.anchorWorkingFingerprint
          )
        );
      const normalizedCapture = sameHistoryState
        ? capture
        : {
            availability: "concurrent-change" as const,
            context: capture.context,
            branch: capture.branch,
            headHash: capture.headHash,
            status: capture.status,
            sizeBytes: capture.sizeBytes
          };
      exactRenameStillMatches = sameHistoryState;
      const working = this.buildWorkingVersion(
        file,
        normalizedCapture,
        capturedAt,
        limits
      );
      workingSnapshot = working.snapshot;
      workingVersion = working.version;
      if (workingVersion.content !== undefined) {
        materializedBytes += workingVersion.sizeBytes ?? 0;
      } else if (workingVersion.unavailableReason) {
        warnings.push(workingVersion.unavailableReason);
      }
    }
    if (history.workingRename?.kind === "staged") {
      warnings.push("已按 Git 暂存区确认的重命名，从旧路径连续读取历史。");
    } else if (
      history.workingRename?.kind === "exact-unstaged"
      && exactRenameStillMatches
    ) {
      warnings.push("已通过与 HEAD 文件内容完全一致，确认未暂存重命名并从旧路径连续读取历史。");
    } else if (history.workingRename?.kind === "exact-unstaged") {
      warnings.push("识别未暂存重命名后当前内容再次变化；旧路径历史仍冻结保留，当前工作区样本标记为未知。");
    }
    if (history.renameWarning) warnings.push(history.renameWarning);

    const commitsOldToNew = [...history.commits].reverse();
    const inspected = await mapWithConcurrency(
      commitsOldToNew,
      limits.maxConcurrency,
      signal,
      async (commit) => {
        if (!isHistoricalPathInsideVault(history.context, commit.historicalPath)) {
          return {
            commit,
            inspection: {
              availability: "physical-boundary" as const,
              sizeBytes: null
            }
          };
        }
        return {
          commit,
          inspection: await this.gitClient.inspectHistoricalFileObject(
            history.context.repositoryRoot,
            commit.hash,
            commit.historicalPath,
            limits.maxFileBytes
          )
        };
      }
    );
    throwIfAborted(signal);

    const plans: HistoricalPlan[] = inspected.map(({ commit, inspection }, index) => ({
        index,
        commitHash: commit.hash,
        historicalPath: commit.historicalPath,
        inspection,
        allowedByTotalLimit: inspection.availability !== "ready"
      }));
    let plannedBytes = materializedBytes;
    for (let index = plans.length - 1; index >= 0; index -= 1) {
      const plan = plans[index]!;
      if (plan.inspection.availability !== "ready") continue;
      if (plannedBytes + plan.inspection.sizeBytes > limits.maxTotalBytes) continue;
      plan.allowedByTotalLimit = true;
      plannedBytes += plan.inspection.sizeBytes;
    }
    const objects = await mapWithConcurrency(
      plans,
      limits.maxConcurrency,
      signal,
      async (plan): Promise<PlannedHistoricalObject> => {
        if (plan.inspection.availability !== "ready") return plan.inspection;
        if (!plan.allowedByTotalLimit) {
          return {
            availability: "ready",
            content: "",
            sizeBytes: plan.inspection.sizeBytes
          };
        }
        return this.gitClient.readHistoricalFileObject(
          history.context.repositoryRoot,
          plan.commitHash,
          plan.historicalPath,
          limits.maxFileBytes
        );
      }
    );

    const historicalVersions = plans.map((plan) => {
      const commit = commitsOldToNew[plan.index]!;
      const object = objects[plan.index]!;
      const base: Omit<KnowledgeTraceVersion, "content" | "unavailableReason"> = {
        key: `commit:${commit.hash}:${commit.historicalPath}`,
        label: `${commit.shortHash} · ${commit.subject || "无提交说明"}`,
        kind: "commit",
        commitHash: commit.hash,
        shortHash: commit.shortHash,
        historicalPath: commit.historicalPath,
        authoredAt: commit.authoredAt,
        subject: commit.subject,
        ...(object.sizeBytes === null
          ? {}
          : { sizeBytes: object.sizeBytes })
      };
      if (!plan.allowedByTotalLimit) {
        return unavailableVersion(base, "total-limit");
      }
      switch (object.availability) {
        case "ready":
          materializedBytes += object.sizeBytes;
          return {
            ...base,
            availability: "ready" as const,
            content: object.content
          };
        case "missing":
          return unavailableVersion(base, "missing");
        case "too-large":
          return unavailableVersion(base, "too-large");
        case "read-error":
          return unavailableVersion(base, "read-error");
        case "physical-boundary":
          return unavailableVersion(base, "physical-boundary");
      }
    });
    if (plans.some((plan) => !plan.allowedByTotalLimit)) {
      warnings.push("部分版本因达到总读取量上限而保留为未知。");
    }
    if (plans.some((plan) => plan.inspection.availability === "too-large")) {
      warnings.push("部分版本超过单文件读取上限，未读取内容。");
    }
    if (
      plans.some((plan) => plan.inspection.availability === "missing")
      || objects.some((object) => object.availability === "read-error")
    ) {
      warnings.push("部分 Git 版本不可读，结果不会跨越这些版本推断。");
    }
    if (objects.some((object) => object.availability === "physical-boundary")) {
      warnings.push("部分历史路径位于 Vault 之外，未读取其正文。");
    }

    const samples = workingVersion
      ? [...historicalVersions, workingVersion]
      : historicalVersions;
    if (workingSnapshot?.availability === "ready") {
      workingSnapshot.staleAtCompletion = await this.isWorkingSnapshotStale(
        file,
        workingSnapshot
      );
      if (workingSnapshot.staleAtCompletion) {
        warnings.push("当前笔记在物化完成前已变化；工作区样本保持冻结并标记为过期。");
      }
    }
    throwIfAborted(signal);

    return {
      context: history.context,
      filePath: file.path,
      branch: history.branch,
      headHash: history.headHash,
      capturedAt,
      samples,
      versions: samples,
      ...(workingSnapshot ? { workingSnapshot } : {}),
      limits,
      hasMoreHistory: history.hasMoreHistory,
      truncated: history.hasMoreHistory,
      materializedBytes,
      warnings
    };
  }

  async isWorkingSnapshotStale(
    file: TFile,
    snapshot: KnowledgeWorkingSnapshot
  ): Promise<boolean> {
    if (
      snapshot.availability !== "ready"
      || snapshot.content === undefined
      || snapshot.fingerprint === undefined
    ) return true;
    const current = await this.gitClient.captureStableWorkingFile(
      file,
      Math.max(snapshot.sizeBytes ?? 0, 1)
    );
    return current.availability !== "ready"
      || current.headHash !== snapshot.headHash
      || current.branch !== snapshot.branch
      || current.status !== snapshot.status
      || current.beforeFingerprint !== snapshot.fingerprint
      || current.content !== snapshot.content;
  }

  private buildWorkingVersion(
    file: TFile,
    capture: StableWorkingFileCapture,
    capturedAt: string,
    limits: KnowledgeMaterializationLimits
  ): {
    version: KnowledgeTraceVersion;
    snapshot: KnowledgeWorkingSnapshot;
  } {
    const versionKey =
      `working:${capture.headHash || "unborn"}:${capturedAt}:${file.path}`;
    const baseVersion: Omit<KnowledgeTraceVersion, "content" | "unavailableReason"> = {
      key: versionKey,
      label: "当前工作区（冻结快照）",
      kind: "working",
      historicalPath: capture.context.repositoryRelativePath,
      ...(capture.sizeBytes === null ? {} : { sizeBytes: capture.sizeBytes })
    };
    const baseSnapshot = {
      versionKey,
      filePath: file.path,
      repositoryPath: capture.context.repositoryRelativePath,
      capturedAt,
      branch: capture.branch,
      headHash: capture.headHash,
      status: capture.status,
      sizeBytes: capture.sizeBytes,
      staleAtCompletion: false
    };
    if (capture.availability === "ready") {
      const version: KnowledgeTraceVersion = {
        ...baseVersion,
        availability: "ready",
        content: capture.content,
        fingerprint: capture.beforeFingerprint
      };
      return {
        version,
        snapshot: {
          ...baseSnapshot,
          availability: "ready",
          content: capture.content,
          fingerprint: capture.beforeFingerprint,
          beforeFingerprint: capture.beforeFingerprint,
          afterFingerprint: capture.afterFingerprint
        }
      };
    }
    const code =
      capture.availability === "too-large"
      && capture.sizeBytes !== null
      && capture.sizeBytes <= limits.maxFileBytes
      && capture.sizeBytes > limits.maxTotalBytes
        ? "total-limit"
        : workingUnavailableCode(capture);
    const version = unavailableVersion(baseVersion, code);
    return {
      version,
      snapshot: {
        ...baseSnapshot,
        availability: "unavailable",
        unavailableCode: code,
        unavailableReason: UNAVAILABLE_REASON[code]
      }
    };
  }
}
