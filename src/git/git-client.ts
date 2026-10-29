import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { App, FileSystemAdapter, TFile } from "obsidian";
import { tr } from "../i18n";
import type {
  GitCommittedChange,
  GitCommitVersion,
  GitConflictVersions,
  GitEmptyHistoryReason,
  GitFileHistory,
  GitFileStatus,
  GitLineStats,
  GitNoteHistorySettings,
  GitNoteStatus,
  GitRepositoryContext,
  ReviewInboxSnapshot,
  GitWorkspaceReview,
  VersionReference
} from "../models";
import {
  parseCommitMetadata,
  parseCommittedNameStatus,
  parseGitLog,
  parseGitStatus,
  parseLatestCommitByPath,
  parseNumStatByPath,
  parseNumStatLog,
  parseSingleNumStat,
  parseZeroDelimitedNumStat,
  parseWorkspaceStatus
} from "./parse-log";
import { limitHistory } from "../history/timeline-window";
import {
  isReviewPathExcluded,
  mergeReviewInboxItems
} from "../review/review-inbox";
import {
  buildLinkImpact,
  isVaultTargetRelation
} from "../analysis/link-impact";
import {
  countUniqueHiddenRepositoryFiles,
  createHiddenRepositoryPathIdentity,
  mergeWorkEventChanges,
  selectInferredSessionCommits
} from "../work-events/work-event";
import { contentFingerprint } from "../history/version-groups";
import type { MergeWorkEventChangesResult } from "../work-events/work-event";
import type {
  WorkEventAnalysisState,
  WorkEventCommit,
  WorkEventFileChange,
  WorkEventRelationDelta,
  WorkEventRequest,
  WorkEventSnapshot
} from "../work-events/types";
import {
  parseLinePorcelain,
  type BlameLine,
  type ProvenanceLensSnapshot
} from "../provenance/provenance-lens";
import type { GitHistoryHealthSnapshot } from "../health/types";

const TRAILING_GROUP_SEPARATOR = new RegExp(`${String.fromCharCode(0x1d)}(?:\\r?\\n)?$`);
const LOG_FORMAT = "%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B%x1d";
const REVIEW_LOG_FORMAT = "%x1e%H%x1f%h%x1f%aI%x1f%s%x1d";
const WORK_EVENT_LOG_FORMAT =
  "%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%B%x1d";
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
// Same limit as the sandbox runner: a stuck Git (lock, prompt, huge repo) must not hang the view forever.
export const GIT_COMMAND_TIMEOUT_MS = 120_000;
const EXACT_UNSTAGED_RENAME_MAX_BYTES = 512 * 1024;
const EXACT_UNSTAGED_RENAME_MAX_CANDIDATES = 64;
const WORK_EVENT_ANALYSIS_LIMITS = {
  maxMarkdownFiles: 60,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxRelationsPerFile: 500,
  maxTotalRelations: 2000
} as const;
const PROVENANCE_LENS_MAX_BYTES = 2 * 1024 * 1024;
const PROVENANCE_LENS_MAX_COMMITS = 240;
const HISTORY_HEALTH_MAX_COMMITS = 120;

export function normalizeMaxCommits(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(1000, Math.trunc(parsed)));
}

function parseWorkEventCommitLog(raw: string): WorkEventCommit[] {
  const commits: WorkEventCommit[] = [];
  for (const part of raw.split("\u001e")) {
    const record = part
      .replace(/^\r?\n/, "")
      .replace(TRAILING_GROUP_SEPARATOR, "");
    if (!record) continue;
    const metadata = parseCommitMetadata(record);
    if (metadata) commits.push(metadata);
  }
  return commits;
}

/** Why Git could not be read, so the view can offer the one step that fits. */
export type GitProblem = "not-repo" | "no-git" | "outside-repo" | "not-desktop" | "timeout" | "failed";

export class GitCommandError extends Error {
  readonly stderr: string;
  readonly problem: GitProblem;

  constructor(message: string, stderr = "", problem: GitProblem = "failed") {
    super(message);
    this.name = "GitCommandError";
    this.stderr = stderr;
    this.problem = problem;
  }
}

export interface ReadOnlyFirstParentFileHistory {
  context: GitRepositoryContext;
  branch: string;
  headHash: string;
  status: string;
  historyPath: string;
  workingRename?: {
    kind: "staged" | "exact-unstaged";
    currentPath: string;
    originalPath: string;
  };
  anchorWorkingFingerprint?: string;
  renameWarning?: string;
  /** Git's newest-to-oldest order. Consumers may reverse this, but must not sort by dates. */
  commits: GitCommitVersion[];
  hasMoreHistory: boolean;
}

export type ReadOnlyHistoricalFileObject =
  | {
      availability: "ready";
      content: string;
      sizeBytes: number;
    }
  | {
      availability: "missing";
      sizeBytes: null;
    }
  | {
      availability: "too-large";
      sizeBytes: number;
    }
  | {
      availability: "read-error";
      sizeBytes: number | null;
    };

export type ReadOnlyHistoricalFileInspection =
  | {
      availability: "ready";
      sizeBytes: number;
    }
  | {
      availability: "missing";
      sizeBytes: null;
    }
  | {
      availability: "too-large";
      sizeBytes: number;
    };

export type StableWorkingFileCapture =
  | {
      availability: "ready";
      context: GitRepositoryContext;
      branch: string;
      headHash: string;
      status: string;
      content: string;
      sizeBytes: number;
      beforeFingerprint: string;
      afterFingerprint: string;
    }
  | {
      availability: "missing" | "too-large" | "physical-boundary" | "concurrent-change";
      context: GitRepositoryContext;
      branch: string;
      headHash: string;
      status: string;
      sizeBytes: number | null;
    };

interface ReadOnlyFileState {
  branch: string;
  headHash: string;
  status: string;
}

interface WorkingHistoryAnchor {
  historyPath: string;
  workingRename?: ReadOnlyFirstParentFileHistory["workingRename"];
  anchorWorkingFingerprint?: string;
  renameWarning?: string;
  validationTrackedStatus?: string;
  validationStagedNameStatus?: string;
}

export class GitClient {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => GitNoteHistorySettings
  ) {}

  async loadFileHistory(
    file: TFile,
    requestedMaxCommits?: number
  ): Promise<GitFileHistory> {
    const context = await this.resolveContext(file);
    const settings = this.getSettings();
    const maxCommits = normalizeMaxCommits(requestedMaxCommits ?? settings.maxCommits);

    const [logOutput, numStatOutput, statusOutput, branchOutput] = await Promise.all([
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "log",
        "--follow",
        "--find-renames",
        `--max-count=${maxCommits + 1}`,
        `--format=${LOG_FORMAT}`,
        "--name-status",
        "--",
        context.repositoryRelativePath
      ]).catch((error: unknown) => {
        if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) {
          return "";
        }
        throw error;
      }),
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "log",
        "--follow",
        "--find-renames",
        `--max-count=${maxCommits + 1}`,
        "--format=%x1e%H",
        "--numstat",
        "--",
        context.repositoryRelativePath
      ]).catch((error: unknown) => {
        if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) return "";
        throw error;
      }),
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        context.repositoryRelativePath
      ]),
      this.getBranch(context.repositoryRoot)
    ]);

    const limitedHistory = limitHistory(parseGitLog(logOutput, context.repositoryRelativePath), maxCommits);
    const commits = limitedHistory.items;
    const stats = parseNumStatLog(numStatOutput);
    for (const commit of commits) {
      const commitStats = stats.get(commit.hash);
      if (!commitStats) continue;
      commit.addedLines = commitStats.addedLines;
      commit.deletedLines = commitStats.deletedLines;
    }

    const status = parseGitStatus(statusOutput);
    const workingTreeStats = await this.getWorkingTreeStats(context, status.untracked, file);
    const empty = commits.length === 0 ? await this.explainEmptyHistory(context, status) : null;

    return {
      context,
      branch: branchOutput.trim() || "HEAD",
      status,
      commits,
      hasMoreHistory: limitedHistory.hasMore,
      workingTreeStats,
      ...(empty ? { emptyReason: empty.reason } : {}),
      ...(empty?.rule ? { ignoreRule: empty.rule } : {})
    };
  }

  /** Cheap summary for the status bar: the last commit touching the note and whether it has uncommitted edits. */
  async loadNoteStatus(file: TFile): Promise<GitNoteStatus> {
    const context = await this.resolveContext(file);
    const [logOutput, statusOutput] = await Promise.all([
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "log",
        "--max-count=1",
        `--format=${LOG_FORMAT}`,
        "--name-status",
        "--",
        context.repositoryRelativePath
      ]).catch((error: unknown) => {
        if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) return "";
        throw error;
      }),
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        context.repositoryRelativePath
      ])
    ]);
    const status = parseGitStatus(statusOutput);
    return {
      context,
      lastCommit: parseGitLog(logOutput, context.repositoryRelativePath)[0] ?? null,
      status
    };
  }

  async loadHistoryHealth(file: TFile): Promise<GitHistoryHealthSnapshot> {
    const history = await this.loadFileHistory(file, Math.min(
      HISTORY_HEALTH_MAX_COMMITS,
      this.getSettings().maxCommits
    ));
    const context = history.context;
    const safe = async (args: string[]): Promise<string> => {
      try {
        return await this.runGit(context.repositoryRoot, args);
      } catch {
        return "";
      }
    };
    const [
      headOutput,
      shallowOutput,
      objectFormatOutput,
      upstreamOutput,
      promisorOutput,
      partialCloneOutput,
      ignoreFileOutput,
      defaultIgnoreRevsOutput,
      missingResult,
      currentContent
    ] = await Promise.all([
      safe(["rev-parse", "HEAD"]),
      safe(["rev-parse", "--is-shallow-repository"]),
      safe(["rev-parse", "--show-object-format"]),
      safe(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      safe(["config", "--get-regexp", "^remote\\..*\\.promisor$"]),
      safe(["config", "--get", "extensions.partialClone"]),
      safe(["config", "--get", "blame.ignoreRevsFile"]),
      safe(["show", "HEAD:.git-blame-ignore-revs"]),
      this.runGit(context.repositoryRoot, [
        "rev-list",
        "--objects",
        "--missing=print",
        "HEAD",
        "--",
        context.repositoryRelativePath
      ]).then(
        (output) => ({ output, error: "" }),
        (error: unknown) => ({
          output: "",
          error: error instanceof Error ? error.message : String(error)
        })
      ),
      file.stat.size <= 2 * 1024 * 1024
        ? this.app.vault.read(file).catch(() => "")
        : Promise.resolve("")
    ]);
    const upstream = upstreamOutput.trim();
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = (await safe([
        "rev-list",
        "--left-right",
        "--count",
        `${upstream}...HEAD`
      ])).trim().split(/\s+/);
      behind = Number.parseInt(counts[0] ?? "0", 10) || 0;
      ahead = Number.parseInt(counts[1] ?? "0", 10) || 0;
    }
    const ignoreFile = ignoreFileOutput.trim();
    const ignoreText = !ignoreFile || ignoreFile === ".git-blame-ignore-revs"
      ? defaultIgnoreRevsOutput
      : "";
    const ignoreRevs = ignoreText
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter((line) => /^[0-9a-f]{7,64}$/i.test(line))
      .map((line) => line.toLowerCase())
      .slice(0, 1000);
    return {
      context,
      history,
      headHash: headOutput.trim(),
      ...(upstream ? { upstream } : {}),
      ahead,
      behind,
      shallow: shallowOutput.trim() === "true",
      partialClone: Boolean(promisorOutput.trim() || partialCloneOutput.trim()),
      objectFormat: objectFormatOutput.trim() || "unknown",
      missingObjects: missingResult.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("?"))
        .slice(0, 100),
      ignoreRevs,
      ignoreRevsConfigured: Boolean(ignoreFile || defaultIgnoreRevsOutput.trim()),
      currentLfsPointer: currentContent.startsWith(
        "version https://git-lfs.github.com/spec/v1"
      ),
      ...(missingResult.error ? { repositoryError: missingResult.error } : {})
    };
  }

  /**
   * Loads one file's path-continuous history without checking out a commit or
   * moving HEAD. The returned commits retain Git's newest-to-oldest traversal
   * order; callers that need chronological presentation should reverse the
   * array rather than sorting by authored timestamps.
   */
  async loadFirstParentFileHistory(
    file: TFile,
    requestedMaxCommits: number
  ): Promise<ReadOnlyFirstParentFileHistory> {
    const context = await this.resolveContext(file);
    const maxCommits = Math.max(0, Math.min(1000, Math.trunc(requestedMaxCommits)));
    const before = await this.readOnlyFileState(context);
    const anchor = await this.resolveWorkingHistoryAnchor(file, context, before);
    const logOutput = await this.runGit(context.repositoryRoot, [
      "-c",
      "core.quotePath=false",
      "log",
      "--first-parent",
      "--full-history",
      "-m",
      "--follow",
      "--find-renames",
      `--max-count=${maxCommits + 1}`,
      `--format=${LOG_FORMAT}`,
      "--name-status",
      "--",
      anchor.historyPath
    ]).catch((error: unknown) => {
      if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) {
        return "";
      }
      throw error;
    });
    const after = await this.readOnlyFileState(context);
    const trackedStatusStillStable =
      anchor.validationTrackedStatus === undefined
      || await this.readTrackedWorkspaceStatus(context.repositoryRoot)
        === anchor.validationTrackedStatus;
    const stagedStatusStillStable =
      anchor.validationStagedNameStatus === undefined
      || await this.readStagedNameStatus(context.repositoryRoot)
        === anchor.validationStagedNameStatus;
    if (
      before.headHash !== after.headHash
      || before.branch !== after.branch
      || before.status !== after.status
      || !trackedStatusStillStable
      || !stagedStatusStillStable
    ) {
      throw new GitCommandError(
        tr("读取期间 Git HEAD、分支或当前笔记状态发生了变化，请重新发起追踪。", "Git HEAD, the branch or the note changed while reading; start the trace again.")
      );
    }

    const parsed = parseGitLog(logOutput, anchor.historyPath);
    return {
      context,
      branch: after.branch,
      headHash: after.headHash,
      status: after.status,
      historyPath: anchor.historyPath,
      ...(anchor.workingRename ? { workingRename: anchor.workingRename } : {}),
      ...(anchor.anchorWorkingFingerprint
        ? { anchorWorkingFingerprint: anchor.anchorWorkingFingerprint }
        : {}),
      ...(anchor.renameWarning ? { renameWarning: anchor.renameWarning } : {}),
      commits: parsed.slice(0, maxCommits),
      hasMoreHistory: parsed.length > maxCommits
    };
  }

  /**
   * Reads an immutable Git object under a byte cap. A missing or unreadable
   * object remains explicit so higher layers can evaluate that version as
   * unknown instead of inferring across the gap.
   */
  async readHistoricalFileObject(
    repositoryRoot: string,
    commitHash: string,
    historicalPath: string,
    maxBytes: number
  ): Promise<ReadOnlyHistoricalFileObject> {
    const inspection = await this.inspectHistoricalFileObject(
      repositoryRoot,
      commitHash,
      historicalPath,
      maxBytes
    );
    if (inspection.availability !== "ready") return inspection;
    const size = inspection.sizeBytes;
    try {
      const content = await this.getFileContent(
        repositoryRoot,
        commitHash,
        historicalPath
      );
      if (Buffer.byteLength(content, "utf8") > Math.max(0, maxBytes)) {
        return { availability: "too-large", sizeBytes: size };
      }
      return { availability: "ready", content, sizeBytes: size };
    } catch {
      return { availability: "read-error", sizeBytes: size };
    }
  }

  async inspectHistoricalFileObject(
    repositoryRoot: string,
    commitHash: string,
    historicalPath: string,
    maxBytes: number
  ): Promise<ReadOnlyHistoricalFileInspection> {
    if (!/^[0-9a-f]{7,64}$/i.test(commitHash)) {
      return { availability: "missing", sizeBytes: null };
    }
    const size = await this.getHistoricalObjectSizeOrNull(
      repositoryRoot,
      commitHash,
      historicalPath
    );
    if (size === null) return { availability: "missing", sizeBytes: null };
    if (size > Math.max(0, maxBytes)) {
      return { availability: "too-large", sizeBytes: size };
    }
    return { availability: "ready", sizeBytes: size };
  }

  /**
   * Freezes the current Vault file with before/after content fingerprints and
   * Git state checks. Physical realpaths are checked on both sides of the read
   * so a symlink cannot make the plugin read outside the Vault boundary.
   */
  async captureStableWorkingFile(
    file: TFile,
    maxBytes: number
  ): Promise<StableWorkingFileCapture> {
    const context = await this.resolveContext(file);
    const beforeState = await this.readOnlyFileState(context);
    const currentFile = this.app.vault.getFileByPath(file.path);
    if (!currentFile) {
      return {
        availability: "missing",
        context,
        ...beforeState,
        sizeBytes: null
      };
    }
    if (!await this.isPhysicalVaultPath(context.vaultRoot, file.path)) {
      return {
        availability: "physical-boundary",
        context,
        ...beforeState,
        sizeBytes: currentFile.stat.size
      };
    }

    const byteLimit = Math.max(0, maxBytes);
    if (currentFile.stat.size > byteLimit) {
      const afterState = await this.readOnlyFileState(context);
      const stillInside = await this.isPhysicalVaultPath(context.vaultRoot, file.path);
      if (
        !stillInside
        || beforeState.headHash !== afterState.headHash
        || beforeState.branch !== afterState.branch
        || beforeState.status !== afterState.status
      ) {
        return {
          availability: "concurrent-change",
          context,
          ...afterState,
          sizeBytes: currentFile.stat.size
        };
      }
      return {
        availability: "too-large",
        context,
        ...afterState,
        sizeBytes: currentFile.stat.size
      };
    }

    const beforeContent = await this.app.vault.read(currentFile);
    const beforeFingerprint = contentFingerprint(beforeContent);
    const afterState = await this.readOnlyFileState(context);
    const refreshedFile = this.app.vault.getFileByPath(file.path);
    if (
      !refreshedFile
      || !await this.isPhysicalVaultPath(context.vaultRoot, file.path)
      || beforeState.headHash !== afterState.headHash
      || beforeState.branch !== afterState.branch
      || beforeState.status !== afterState.status
    ) {
      return {
        availability: "concurrent-change",
        context,
        ...afterState,
        sizeBytes: refreshedFile?.stat.size ?? null
      };
    }
    const afterContent = await this.app.vault.read(refreshedFile);
    const afterFingerprint = contentFingerprint(afterContent);
    const finalState = await this.readOnlyFileState(context);
    if (
      !await this.isPhysicalVaultPath(context.vaultRoot, file.path)
      || beforeContent !== afterContent
      || beforeFingerprint !== afterFingerprint
      || beforeState.headHash !== finalState.headHash
      || beforeState.branch !== finalState.branch
      || beforeState.status !== finalState.status
    ) {
      return {
        availability: "concurrent-change",
        context,
        ...finalState,
        sizeBytes: refreshedFile.stat.size
      };
    }
    const actualSize = Buffer.byteLength(beforeContent, "utf8");
    if (actualSize > byteLimit) {
      return {
        availability: "too-large",
        context,
        ...finalState,
        sizeBytes: actualSize
      };
    }
    return {
      availability: "ready",
      context,
      ...finalState,
      content: beforeContent,
      sizeBytes: actualSize,
      beforeFingerprint,
      afterFingerprint
    };
  }

  async getFileContent(
    repositoryRoot: string,
    commitHash: string,
    historicalPath: string
  ): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(commitHash)) {
      throw new GitCommandError(tr("Git 提交哈希格式无效。", "Invalid Git commit hash."));
    }

    return this.runGit(repositoryRoot, ["show", `${commitHash}:${historicalPath}`]);
  }

  async readReviewGitNote(repositoryRoot: string, commitHash: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(commitHash)) {
      throw new GitCommandError(tr("Git 提交哈希格式无效。", "Invalid Git commit hash."));
    }
    try {
      return await this.runGit(repositoryRoot, [
        "notes",
        "--ref=git-note-history-review",
        "show",
        commitHash
      ]);
    } catch (error) {
      if (
        error instanceof GitCommandError
        && /no note found|cannot read note data|failed to resolve/i.test(error.stderr)
      ) return "";
      throw error;
    }
  }

  async writeReviewGitNote(
    repositoryRoot: string,
    commitHash: string,
    content: string
  ): Promise<void> {
    if (!/^[0-9a-f]{7,64}$/i.test(commitHash)) {
      throw new GitCommandError(tr("Git 提交哈希格式无效。", "Invalid Git commit hash."));
    }
    if (!content.trim()) throw new GitCommandError(tr("Git notes 内容不能为空。", "Git notes content cannot be empty."));
    await this.runGit(repositoryRoot, [
      "notes",
      "--ref=git-note-history-review",
      "add",
      "-f",
      "-F",
      "-",
      commitHash
    ], content);
  }

  async getContentForReference(
    file: TFile,
    repositoryRoot: string,
    reference: VersionReference
  ): Promise<string> {
    if (reference.kind === "working") return this.app.vault.read(file);
    return this.getFileContent(
      repositoryRoot,
      reference.commit.hash,
      reference.commit.historicalPath
    );
  }

  async getLineHistory(file: TFile, startLine: number, endLine: number): Promise<GitCommitVersion[]> {
    const context = await this.resolveContext(file);
    const lineRange = `${Math.max(1, startLine)},${Math.max(startLine, endLine)}:${context.repositoryRelativePath}`;
    const output = await this.runGit(context.repositoryRoot, [
      "-c",
      "core.quotePath=false",
      "log",
      `--max-count=${Math.min(100, this.getSettings().maxCommits)}`,
      `--format=${LOG_FORMAT}`,
      "--no-patch",
      "-L",
      lineRange
    ]);
    return parseGitLog(output, context.repositoryRelativePath);
  }

  async loadProvenanceLens(file: TFile): Promise<ProvenanceLensSnapshot> {
    const history = await this.loadFileHistory(file, PROVENANCE_LENS_MAX_COMMITS);
    const capture = await this.captureStableWorkingFile(
      file,
      PROVENANCE_LENS_MAX_BYTES
    );
    if (capture.availability !== "ready") {
      const labels = {
        missing: tr("当前笔记已经不存在。", "The note no longer exists."),
        "too-large": tr("当前笔记超过 2 MB，可信度镜头未读取正文。", "The note is over 2 MB; the lens did not read its text."),
        "physical-boundary": tr("当前笔记的物理路径超出 Vault，可信度镜头拒绝读取。", "The note's physical path is outside the vault; the lens refused to read it."),
        "concurrent-change": tr("读取期间笔记或 Git 状态发生变化，请重试。", "The note or Git state changed while reading; try again.")
      } as const;
      throw new GitCommandError(labels[capture.availability]);
    }
    const latest = history.commits[0];
    const historyPath = latest?.historicalPath
      ?? history.context.repositoryRelativePath;
    const rawBlame = capture.headHash
      ? await this.runGit(
          history.context.repositoryRoot,
          [
            "-c",
            "core.quotePath=false",
            "blame",
            "--line-porcelain",
            "--contents",
            "-",
            capture.headHash,
            "--",
            historyPath
          ],
          capture.content
        ).catch(() => "")
      : "";
    const blame = parseLinePorcelain(rawBlame);
    const completeBlame = blame.length > 0
      ? blame
      : capture.content.split(/\r?\n/).map((content, index): BlameLine => ({
          line: index + 1,
          hash: "0".repeat(capture.headHash.length === 64 ? 64 : 40),
          content,
          authorName: "",
          authorEmail: "",
          authoredAt: "",
          working: true
        }));
    let previousContent: string | undefined;
    if (latest) {
      const previous = await this.readHistoricalFileObject(
        history.context.repositoryRoot,
        latest.hash,
        latest.historicalPath,
        PROVENANCE_LENS_MAX_BYTES
      );
      if (previous.availability === "ready") previousContent = previous.content;
    }
    const after = await this.captureStableWorkingFile(
      file,
      PROVENANCE_LENS_MAX_BYTES
    );
    if (
      after.availability !== "ready"
      || after.beforeFingerprint !== capture.beforeFingerprint
      || after.headHash !== capture.headHash
      || after.status !== capture.status
      || after.branch !== capture.branch
    ) {
      throw new GitCommandError(
        tr("生成可信度镜头期间笔记或 Git 状态发生变化，请重新打开。", "The note or Git state changed while building the lens; open it again.")
      );
    }
    return {
      content: capture.content,
      ...(previousContent !== undefined ? { previousContent } : {}),
      blame: completeBlame,
      commits: history.commits,
      context: history.context,
      branch: history.branch,
      headHash: capture.headHash,
      workingFingerprint: capture.beforeFingerprint,
      hasMoreHistory: history.hasMoreHistory,
      historyPath
    };
  }

  async loadWorkspaceReview(): Promise<GitWorkspaceReview> {
    const { vaultRoot, repositoryRoot } = await this.resolveRepository();
    const [statusOutput, statsOutput, branch] = await Promise.all([
      this.runGit(repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all"
      ]),
      this.runGit(repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "diff",
        "HEAD",
        "--numstat",
        "--"
      ]).catch(
        (error: unknown) => {
          if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) return "";
          throw error;
        }
      ),
      this.getBranch(repositoryRoot)
    ]);

    const reviewContext: GitRepositoryContext = {
      vaultRoot,
      repositoryRoot,
      repositoryRelativePath: ""
    };
    const changes = parseWorkspaceStatus(statusOutput).filter((change) => {
      if (!change.path.toLowerCase().endsWith(".md")) return false;
      const vaultPath = this.repositoryPathToVaultPath(reviewContext, change.path);
      return vaultPath !== ".." && !vaultPath.startsWith("../") && !path.isAbsolute(vaultPath);
    });
    const statsByPath = parseNumStatByPath(statsOutput);
    for (const change of changes) {
      const stats = statsByPath.get(change.path);
      if (stats) {
        change.addedLines = stats.addedLines;
        change.deletedLines = stats.deletedLines;
        if (stats.binary !== undefined) change.binary = stats.binary;
      } else if (change.untracked) {
        const vaultPath = this.repositoryPathToVaultPath(
          { vaultRoot, repositoryRoot, repositoryRelativePath: change.path },
          change.path
        );
        const file = this.app.vault.getFileByPath(vaultPath);
        if (file) {
          const content = await this.app.vault.read(file);
          change.addedLines = content === "" ? 0 : content.split(/\r?\n/).length;
        }
      }
    }

    return {
      context: { vaultRoot, repositoryRoot },
      branch: branch.trim() || "HEAD",
      changes
    };
  }

  async loadReviewInbox(
    baselineHash: string | undefined,
    excludedPaths: string[]
  ): Promise<ReviewInboxSnapshot> {
    const workspace = await this.loadWorkspaceReview();
    const { vaultRoot, repositoryRoot } = workspace.context;
    const headHash = (await this.runGit(repositoryRoot, ["rev-parse", "HEAD"]).catch(
      (error: unknown) => {
        if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) return "";
        throw error;
      }
    )).trim();

    let baselineValid = true;
    let committedChanges: GitCommittedChange[] = [];
    if (baselineHash && headHash) {
      if (!/^[0-9a-f]{7,64}$/i.test(baselineHash)) {
        baselineValid = false;
      } else {
        try {
          const [nameStatusOutput, statsOutput, logOutput] = await Promise.all([
            this.runGit(repositoryRoot, [
              "-c",
              "core.quotePath=false",
              "diff",
              "--find-renames",
              "--name-status",
              "-z",
              baselineHash,
              headHash,
              "--",
              "*.md"
            ]),
            this.runGit(repositoryRoot, [
              "-c",
              "core.quotePath=false",
              "diff",
              baselineHash,
              headHash,
              "--numstat",
              "--",
              "*.md"
            ]),
            this.runGit(repositoryRoot, [
              "-c",
              "core.quotePath=false",
              "log",
              `${baselineHash}..${headHash}`,
              `--format=${REVIEW_LOG_FORMAT}`,
              "--name-status",
              "--",
              "*.md"
            ])
          ]);
          const statsByPath = parseNumStatByPath(statsOutput);
          const latestByPath = parseLatestCommitByPath(logOutput);
          committedChanges = parseCommittedNameStatus(nameStatusOutput).filter((change) => {
            if (!change.path.toLocaleLowerCase().endsWith(".md")) return false;
            const context: GitRepositoryContext = {
              vaultRoot,
              repositoryRoot,
              repositoryRelativePath: change.path
            };
            const vaultPath = this.repositoryPathToVaultPath(context, change.path);
            return vaultPath !== ".."
              && !vaultPath.startsWith("../")
              && !path.isAbsolute(vaultPath)
              && !isReviewPathExcluded(vaultPath, excludedPaths);
          });
          for (const change of committedChanges) {
            const stats = statsByPath.get(change.path);
            if (stats) {
              change.addedLines = stats.addedLines;
              change.deletedLines = stats.deletedLines;
              if (stats.binary !== undefined) change.binary = stats.binary;
            }
            const latestCommit = latestByPath.get(change.path);
            if (latestCommit) change.latestCommit = latestCommit;
          }
        } catch {
          baselineValid = false;
          committedChanges = [];
        }
      }
    }

    const context: GitRepositoryContext = {
      vaultRoot,
      repositoryRoot,
      repositoryRelativePath: ""
    };
    const workspaceChanges = workspace.changes.filter((change) => {
      const vaultPath = this.repositoryPathToVaultPath(context, change.path);
      return !isReviewPathExcluded(vaultPath, excludedPaths);
    });
    const items = mergeReviewInboxItems(
      committedChanges,
      workspaceChanges,
      (repositoryPath) => this.repositoryPathToVaultPath(context, repositoryPath)
    );

    return {
      context: workspace.context,
      branch: workspace.branch,
      headHash,
      ...(baselineHash ? { baselineHash } : {}),
      baselineValid,
      items
    };
  }

  async loadWorkEvent(request: WorkEventRequest): Promise<WorkEventSnapshot> {
    const { vaultRoot, repositoryRoot } = await this.resolveRepository();
    if (request.repositoryRoot) {
      const requestedRoot = await this.resolveRealPath(request.repositoryRoot);
      if (requestedRoot !== repositoryRoot) {
        throw new GitCommandError(tr("工作事件请求来自另一个 Git 仓库，请从时间线重新打开。", "The work event request comes from another Git repository; open it again from the timeline."));
      }
    }
    const branch = (await this.getBranch(repositoryRoot)).trim() || "HEAD";
    const context = { vaultRoot, repositoryRoot };
    if (request.source.kind === "working") {
      return this.loadWorkingWorkEvent(context, branch, request);
    }
    return this.loadCommittedWorkEvent(context, branch, request, request.source);
  }

  repositoryPathToVaultPath(context: GitRepositoryContext, repositoryPath: string): string {
    const absolutePath = path.resolve(context.repositoryRoot, repositoryPath);
    return path.relative(context.vaultRoot, absolutePath).split(path.sep).join("/");
  }

  async getLatestExistingContent(
    repositoryRoot: string,
    repositoryPath: string
  ): Promise<{ hash: string; content: string }> {
    const hash = (await this.runGit(repositoryRoot, [
      "log",
      "-1",
      "--diff-filter=AMR",
      "--format=%H",
      "--",
      repositoryPath
    ])).trim();
    if (!hash) throw new GitCommandError(tr("Git 中没有找到可恢复的文件版本。", "No restorable file version was found in Git."));
    const content = await this.getFileContent(repositoryRoot, hash, repositoryPath);
    return { hash, content };
  }

  async resolveFileContext(file: TFile): Promise<GitRepositoryContext> {
    return this.resolveContext(file);
  }

  async resolveVaultPathContext(vaultPath: string): Promise<GitRepositoryContext> {
    const { vaultRoot, repositoryRoot } = await this.resolveRepository();
    const absoluteFilePath = path.resolve(vaultRoot, vaultPath);
    const repositoryRelativePath = path.relative(repositoryRoot, absoluteFilePath);
    if (
      repositoryRelativePath === ""
      || repositoryRelativePath.startsWith(`..${path.sep}`)
      || repositoryRelativePath === ".."
      || path.isAbsolute(repositoryRelativePath)
    ) {
      throw new GitCommandError(tr("当前笔记不在检测到的 Git 仓库中。", "This note is outside the detected Git repository."), "", "outside-repo");
    }
    return {
      vaultRoot,
      repositoryRoot,
      repositoryRelativePath: repositoryRelativePath.split(path.sep).join("/")
    };
  }

  async resolveRepositoryContext(): Promise<Omit<GitRepositoryContext, "repositoryRelativePath">> {
    return this.resolveRepository();
  }

  async getConflictVersions(file: TFile): Promise<GitConflictVersions> {
    const context = await this.resolveContext(file);
    const unmerged = await this.runGit(context.repositoryRoot, [
      "ls-files",
      "-u",
      "--",
      context.repositoryRelativePath
    ]);
    if (!unmerged.trim()) {
      throw new GitCommandError(tr("当前笔记没有 Git 索引冲突。", "The note has no Git index conflict."));
    }

    const readStage = async (stage: 1 | 2 | 3): Promise<string> => {
      try {
        return await this.runGit(context.repositoryRoot, [
          "show",
          `:${stage}:${context.repositoryRelativePath}`
        ]);
      } catch {
        return "";
      }
    };

    const [ancestor, ours, theirs, working] = await Promise.all([
      readStage(1),
      readStage(2),
      readStage(3),
      this.app.vault.read(file)
    ]);
    return { context, ancestor, ours, theirs, working };
  }

  private async loadCommittedWorkEvent(
    context: Omit<GitRepositoryContext, "repositoryRelativePath">,
    branch: string,
    request: WorkEventRequest,
    source: Extract<WorkEventRequest["source"], { kind: "commit" }>
  ): Promise<WorkEventSnapshot> {
    const { commitHash, aggregation } = source;
    if (!/^[0-9a-f]{7,64}$/i.test(commitHash)) {
      throw new GitCommandError(tr("Git 提交哈希格式无效。", "Invalid Git commit hash."));
    }
    const logOutput = await this.runGit(context.repositoryRoot, [
      "log",
      "--first-parent",
      "--max-count=13",
      `--format=${WORK_EVENT_LOG_FORMAT}`,
      commitHash
    ]);
    const candidates = parseWorkEventCommitLog(logOutput);
    const anchor = candidates[0];
    if (!anchor || !anchor.hash.toLocaleLowerCase().startsWith(commitHash.toLocaleLowerCase())) {
      throw new GitCommandError(tr("没有找到这次工作事件对应的 Git 提交。", "No Git commit matches this work event."));
    }

    const selection = aggregation === "session"
      ? selectInferredSessionCommits(
          candidates,
          source.milestoneHashes ?? [],
          12
        )
      : {
          commits: [anchor],
          confidence: "exact" as const,
          reason: tr("精确显示这一个 Git 提交。", "Shows exactly this one Git commit.")
        };
    const sessionTruncated = aggregation === "session"
      && selectInferredSessionCommits(
        candidates,
        source.milestoneHashes ?? [],
        13
      ).commits.length > selection.commits.length;
    const commits = selection.commits;
    const oldest = commits.at(-1)!;
    const baseHash = oldest.parentHashes[0];
    const headHash = anchor.hash;
    const hiddenPathIdentity = createHiddenRepositoryPathIdentity();
    const sliceResults = await Promise.all(
      commits.map((commit) =>
        this.loadCommittedChangeSet(
          context,
          commit.parentHashes[0],
          commit.hash,
          request.anchorVaultPath,
          request.anchorHistoricalPath,
          hiddenPathIdentity
        )
      )
    );
    const slices = commits.map((commit, index) => {
      const result = sliceResults[index]!;
      return {
        commit,
        changes: result.changes,
        hiddenRepositoryFileCount: result.hiddenRepositoryFileCount
      };
    });
    const net = commits.length === 1
      ? {
          changes: slices[0]?.changes.map((change) => ({ ...change })) ?? [],
          hiddenRepositoryFileCount: slices[0]?.hiddenRepositoryFileCount ?? 0,
          hiddenRepositoryFileIdentityGroups:
            sliceResults[0]?.hiddenRepositoryFileIdentityGroups ?? []
        }
      : await this.loadCommittedChangeSet(
          context,
          baseHash,
          headHash,
          request.anchorVaultPath,
          request.anchorHistoricalPath,
          hiddenPathIdentity
        );
    const hiddenRepositoryFileCount = commits.length === 1
      ? net.hiddenRepositoryFileCount
      : countUniqueHiddenRepositoryFiles([
          ...sliceResults.flatMap(
            (result) => result.hiddenRepositoryFileIdentityGroups
          ),
          ...net.hiddenRepositoryFileIdentityGroups
        ]);
    const sessionRestoredFiles = commits.length > 1
      ? this.includeSessionTouchedFiles(net.changes, slices)
      : 0;
    const hydrated = await this.hydrateWorkEventMarkdown(
      context,
      net.changes,
      baseHash,
      headHash,
      false
    );
    const capturedAt = new Date().toISOString();
    const warnings = [...hydrated.warnings];
    if (selection.confidence === "heuristic") {
      warnings.unshift(tr(`编辑会话为推测结果：${selection.reason}`, `The editing session is a guess: ${selection.reason}`));
    }
    if (sessionTruncated) {
      warnings.push(tr("这组自动备份已达到 12 个提交上限，会话可能从更早开始。", "This group of automatic backups reached the 12-commit limit; the session may have started earlier."));
    }
    if (sessionRestoredFiles > 0) {
      warnings.push(
        tr(`${sessionRestoredFiles} 个文件在会话中曾修改，但结束时回到了起点内容。`, `${sessionRestoredFiles} files changed during the session but ended back at their starting content.`)
      );
    }
    if (hiddenRepositoryFileCount > 0) {
      warnings.push(
        tr(`另有 ${hiddenRepositoryFileCount} 个 Vault 外仓库文件未展示。`, `${hiddenRepositoryFileCount} more repository files outside the vault are not shown.`)
      );
    }
    return {
      id: `${selection.confidence === "heuristic" ? "git-session" : "git-commit"}:${headHash}:${baseHash ?? "root"}`,
      source: selection.confidence === "heuristic" ? "git-session" : "git-commit",
      confidence: selection.confidence,
      aggregation,
      repositoryRoot: context.repositoryRoot,
      vaultRoot: context.vaultRoot,
      branch,
      ...(request.anchorVaultPath ? { anchorVaultPath: request.anchorVaultPath } : {}),
      ...(request.anchorHistoricalPath
        ? { anchorHistoricalPath: request.anchorHistoricalPath }
        : {}),
      ...(baseHash ? { baseHash } : {}),
      headHash,
      startedAt: oldest.committedAt,
      endedAt: anchor.committedAt,
      capturedAt,
      commits,
      commitSlices: slices,
      netChanges: hydrated.changes,
      relationDeltas: hydrated.relations,
      hiddenRepositoryFileCount,
      warnings,
      analysis: hydrated.analysis
    };
  }

  private includeSessionTouchedFiles(
    netChanges: WorkEventFileChange[],
    slices: WorkEventSnapshot["commitSlices"]
  ): number {
    const netPaths = new Set(
      netChanges.flatMap((change) => [
        change.repositoryPath,
        ...(change.originalRepositoryPath ? [change.originalRepositoryPath] : [])
      ])
    );
    const restored = new Map<string, WorkEventFileChange>();
    for (const slice of slices) {
      for (const change of slice.changes) {
        if (
          netPaths.has(change.repositoryPath)
          || (
            change.originalRepositoryPath
            && netPaths.has(change.originalRepositoryPath)
          )
        ) continue;
        const key = change.vaultPath;
        const existing = restored.get(key);
        if (existing) {
          existing.addedLines += change.addedLines;
          existing.deletedLines += change.deletedLines;
          existing.isAnchor = existing.isAnchor || change.isAnchor;
          continue;
        }
        restored.set(key, {
          ...change,
          status: "M",
          netUnchanged: true,
          previewStatus: "unavailable"
        });
      }
    }
    netChanges.push(...restored.values());
    return restored.size;
  }

  private async loadWorkingWorkEvent(
    context: Omit<GitRepositoryContext, "repositoryRelativePath">,
    branch: string,
    request: WorkEventRequest
  ): Promise<WorkEventSnapshot> {
    const headHash = (await this.runGit(context.repositoryRoot, [
      "rev-parse",
      "HEAD"
    ]).catch((error: unknown) => {
      if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) {
        return "";
      }
      throw error;
    })).trim();
    const [statusOutput, nameStatusOutput, statsOutput] = await Promise.all([
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all"
      ]),
      headHash
        ? this.runGit(context.repositoryRoot, [
            "-c",
            "core.quotePath=false",
            "diff",
            headHash,
            "--find-renames",
            "--find-copies",
            "--name-status",
            "-z",
            "--"
          ])
        : Promise.resolve(""),
      headHash
        ? this.runGit(context.repositoryRoot, [
            "-c",
            "core.quotePath=false",
            "diff",
            headHash,
            "--find-renames",
            "--find-copies",
            "--numstat",
            "-z",
            "--"
          ])
        : Promise.resolve("")
    ]);
    const workspace = parseWorkspaceStatus(statusOutput);
    const statuses = parseCommittedNameStatus(nameStatusOutput);
    const statusByPath = new Map(statuses.map((status) => [status.path, status]));
    for (const change of workspace) {
      let status = statusByPath.get(change.path);
      if (!status && (change.untracked || !headHash || change.conflicted)) {
        const status: GitCommittedChange = {
          path: change.path,
          ...(change.originalPath ? { originalPath: change.originalPath } : {}),
          changeType: change.conflicted ? "U" : "A",
          addedLines: 0,
          deletedLines: 0
        };
        statuses.push(status);
        statusByPath.set(status.path, status);
        continue;
      }
      if (!change.conflicted) continue;
      status = statusByPath.get(change.path);
      if (status) {
        status.changeType = "U";
      } else {
        const conflict: GitCommittedChange = {
          path: change.path,
          changeType: "U",
          addedLines: 0,
          deletedLines: 0
        };
        statuses.push(conflict);
        statusByPath.set(conflict.path, conflict);
      }
    }
    const merged = mergeWorkEventChanges(
      statuses,
      parseZeroDelimitedNumStat(statsOutput),
      {
        toVaultPath: (repositoryPath) =>
          this.workEventVaultPath(context, repositoryPath),
        ...(request.anchorVaultPath
          ? { anchorVaultPath: request.anchorVaultPath }
          : {})
      }
    );
    for (const change of merged.changes) {
      const matching = workspace.find((item) =>
        item.path === change.repositoryPath
        || item.originalPath === change.repositoryPath
      );
      if (!matching) continue;
      if (matching.conflicted) change.conflicted = true;
      if (matching.untracked) change.untracked = true;
    }
    const hydrated = await this.hydrateWorkEventMarkdown(
      context,
      merged.changes,
      headHash || undefined,
      headHash || undefined,
      true
    );
    const stateAfter = await this.readWorkingEventGitState(
      context.repositoryRoot,
      headHash
    );
    if (
      stateAfter.headHash !== headHash
      || stateAfter.status !== statusOutput
      || stateAfter.nameStatus !== nameStatusOutput
      || stateAfter.stats !== statsOutput
    ) {
      throw new GitCommandError(
        tr("读取期间 Git HEAD 或工作区发生了变化，请重新采样当前未提交工作。", "Git HEAD or the working copy changed while reading; sample the uncommitted work again.")
      );
    }
    await this.assertWorkingPreviewUnchanged(context, hydrated.changes);
    const finalState = await this.readWorkingEventGitState(
      context.repositoryRoot,
      headHash
    );
    if (
      finalState.headHash !== headHash
      || finalState.status !== statusOutput
      || finalState.nameStatus !== nameStatusOutput
      || finalState.stats !== statsOutput
    ) {
      throw new GitCommandError(
        tr("读取期间 Git HEAD 或工作区发生了变化，请重新采样当前未提交工作。", "Git HEAD or the working copy changed while reading; sample the uncommitted work again.")
      );
    }
    const capturedAt = new Date().toISOString();
    const warnings = [...hydrated.warnings];
    if (merged.hiddenRepositoryFileCount > 0) {
      warnings.push(
        tr(`另有 ${merged.hiddenRepositoryFileCount} 个 Vault 外仓库文件未展示。`, `${merged.hiddenRepositoryFileCount} more repository files outside the vault are not shown.`)
      );
    }
    return {
      id: `working:${headHash || "unborn"}:${capturedAt}`,
      source: "working",
      confidence: "snapshot",
      aggregation: "working",
      repositoryRoot: context.repositoryRoot,
      vaultRoot: context.vaultRoot,
      branch,
      ...(request.anchorVaultPath ? { anchorVaultPath: request.anchorVaultPath } : {}),
      ...(request.anchorHistoricalPath
        ? { anchorHistoricalPath: request.anchorHistoricalPath }
        : {}),
      ...(headHash ? { baseHash: headHash, headHash } : {}),
      endedAt: capturedAt,
      capturedAt,
      commits: [],
      commitSlices: [],
      netChanges: hydrated.changes,
      relationDeltas: hydrated.relations,
      hiddenRepositoryFileCount: merged.hiddenRepositoryFileCount,
      warnings,
      analysis: hydrated.analysis
    };
  }

  private async loadCommittedChangeSet(
    context: Omit<GitRepositoryContext, "repositoryRelativePath">,
    baseHash: string | undefined,
    targetHash: string,
    anchorVaultPath?: string,
    anchorRepositoryPath?: string,
    hiddenPathIdentity?: (repositoryPath: string) => string
  ): Promise<MergeWorkEventChangesResult> {
    const base = baseHash ?? await this.getEmptyTreeHash(context.repositoryRoot);
    const [nameStatusOutput, statsOutput] = await Promise.all([
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "diff",
        "--find-renames",
        "--find-copies",
        "--name-status",
        "-z",
        base,
        targetHash,
        "--"
      ]),
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "diff",
        "--find-renames",
        "--find-copies",
        "--numstat",
        "-z",
        base,
        targetHash,
        "--"
      ])
    ]);
    return mergeWorkEventChanges(
      parseCommittedNameStatus(nameStatusOutput),
      parseZeroDelimitedNumStat(statsOutput),
      {
        toVaultPath: (repositoryPath) =>
          this.workEventVaultPath(context, repositoryPath),
        ...(anchorVaultPath ? { anchorVaultPath } : {}),
        ...(anchorRepositoryPath ? { anchorRepositoryPath } : {}),
        ...(hiddenPathIdentity ? { hiddenPathIdentity } : {})
      }
    );
  }

  private workEventVaultPath(
    context: Omit<GitRepositoryContext, "repositoryRelativePath">,
    repositoryPath: string
  ): string | null {
    const vaultPath = this.repositoryPathToVaultPath(
      { ...context, repositoryRelativePath: repositoryPath },
      repositoryPath
    );
    if (
      vaultPath === ".."
      || vaultPath.startsWith("../")
      || path.isAbsolute(vaultPath)
    ) return null;
    return vaultPath;
  }

  private async hydrateWorkEventMarkdown(
    context: Omit<GitRepositoryContext, "repositoryRelativePath">,
    sourceChanges: readonly WorkEventFileChange[],
    baseHash: string | undefined,
    targetHash: string | undefined,
    workingTarget: boolean
  ): Promise<{
    changes: WorkEventFileChange[];
    relations: WorkEventRelationDelta[];
    warnings: string[];
    analysis: WorkEventAnalysisState;
  }> {
    const changes = sourceChanges.map((change) => ({ ...change }));
    const markdown = changes.filter((change) => change.kind === "markdown");
    const relations: WorkEventRelationDelta[] = [];
    const warnings: string[] = [];
    let analyzedMarkdownFiles = 0;
    let skippedMarkdownFiles = 0;
    let physicalBoundarySkipped = 0;
    let analyzedBytes = 0;
    let skippedRelationChanges = 0;
    const changedPaths = new Set(
      changes.flatMap((change) => [
        change.vaultPath,
        ...(change.originalVaultPath ? [change.originalVaultPath] : [])
      ])
    );

    if (workingTarget) {
      for (const change of changes) {
        if (change.status === "D") continue;
        const currentFile = this.app.vault.getFileByPath(change.vaultPath);
        if (
          currentFile
          && !await this.isPhysicalVaultPath(context.vaultRoot, change.vaultPath)
        ) {
          change.openable = false;
        }
      }
    }

    for (const [index, change] of markdown.entries()) {
      if (index >= WORK_EVENT_ANALYSIS_LIMITS.maxMarkdownFiles) {
        change.previewStatus = "too-large";
        skippedMarkdownFiles += 1;
        continue;
      }
      const beforePath = change.originalRepositoryPath ?? change.repositoryPath;
      let beforeSize = 0;
      if (change.status !== "A" || change.originalRepositoryPath) {
        if (!baseHash) {
          change.previewStatus = "unavailable";
          skippedMarkdownFiles += 1;
          continue;
        }
        const size = await this.getHistoricalObjectSizeOrNull(
          context.repositoryRoot,
          baseHash,
          beforePath
        );
        if (size === null) {
          change.previewStatus = "unavailable";
          skippedMarkdownFiles += 1;
          continue;
        }
        beforeSize = size;
      }

      let workingFile: TFile | null = null;
      let afterSize = 0;
      if (change.status !== "D") {
        if (workingTarget) {
          workingFile = this.app.vault.getFileByPath(change.vaultPath);
          if (
            !workingFile
            || change.openable === false
          ) {
            change.previewStatus = "unavailable";
            skippedMarkdownFiles += 1;
            if (workingFile) physicalBoundarySkipped += 1;
            continue;
          }
          afterSize = workingFile.stat?.size ?? 0;
        } else {
          if (!targetHash) {
            change.previewStatus = "unavailable";
            skippedMarkdownFiles += 1;
            continue;
          }
          const size = await this.getHistoricalObjectSizeOrNull(
            context.repositoryRoot,
            targetHash,
            change.repositoryPath
          );
          if (size === null) {
            change.previewStatus = "unavailable";
            skippedMarkdownFiles += 1;
            continue;
          }
          afterSize = size;
        }
      }
      const estimatedBytes = beforeSize + afterSize;
      if (
        estimatedBytes > WORK_EVENT_ANALYSIS_LIMITS.maxFileBytes
        || analyzedBytes + estimatedBytes > WORK_EVENT_ANALYSIS_LIMITS.maxTotalBytes
      ) {
        change.previewStatus = "too-large";
        skippedMarkdownFiles += 1;
        continue;
      }

      let before: string | null;
      if (change.status === "A" && !change.originalRepositoryPath) {
        before = "";
      } else {
        before = await this.readHistoricalContentOrNull(
          context.repositoryRoot,
          baseHash!,
          beforePath
        );
      }

      let after: string | null;
      if (change.status === "D") {
        after = "";
      } else if (workingTarget) {
        after = await this.app.vault.read(workingFile!);
      } else {
        after = await this.readHistoricalContentOrNull(
          context.repositoryRoot,
          targetHash!,
          change.repositoryPath
        );
      }
      if (before === null || after === null) {
        change.previewStatus = "unavailable";
        skippedMarkdownFiles += 1;
        continue;
      }
      if (change.status === "A" && change.addedLines === 0) {
        change.addedLines = after === "" ? 0 : after.split(/\r?\n/).length;
      }
      if (change.status === "D" && change.deletedLines === 0) {
        change.deletedLines = before === "" ? 0 : before.split(/\r?\n/).length;
      }
      const bytes = Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8");
      if (
        bytes > WORK_EVENT_ANALYSIS_LIMITS.maxFileBytes
        || analyzedBytes + bytes > WORK_EVENT_ANALYSIS_LIMITS.maxTotalBytes
      ) {
        change.previewStatus = "too-large";
        skippedMarkdownFiles += 1;
        continue;
      }
      change.beforeContent = before;
      change.afterContent = after;
      change.previewStatus = "ready";
      analyzedMarkdownFiles += 1;
      analyzedBytes += bytes;

      const impact = buildLinkImpact(before, after);
      const availableRelationSlots = Math.max(
        0,
        WORK_EVENT_ANALYSIS_LIMITS.maxTotalRelations - relations.length
      );
      const fileRelations = [
        ...impact.added.map((relation) => ({ relation, relationChange: "added" as const })),
        ...impact.removed.map((relation) => ({ relation, relationChange: "removed" as const }))
      ];
      const acceptedRelations = fileRelations.slice(
        0,
        Math.min(WORK_EVENT_ANALYSIS_LIMITS.maxRelationsPerFile, availableRelationSlots)
      );
      skippedRelationChanges += fileRelations.length - acceptedRelations.length;
      for (const { relation, relationChange } of acceptedRelations) {
        const sourcePath = relationChange === "added"
          ? change.vaultPath
          : change.originalVaultPath ?? change.vaultPath;
        let resolvedPath: string | undefined;
        if (isVaultTargetRelation(relation)) {
          try {
            resolvedPath = this.app.metadataCache
              ?.getFirstLinkpathDest(relation.target, sourcePath)
              ?.path;
          } catch {
            // Historical paths and malformed targets may not resolve in the current Vault.
          }
        }
        const delta: WorkEventRelationDelta = {
          change: relationChange,
          kind: relation.kind,
          target: relation.target,
          label: relation.label,
          eventLocal: isVaultTargetRelation(relation)
            && this.isEventLocalRelation(relation.target, sourcePath, changedPaths)
        };
        if (relationChange === "removed") {
          delta.sourceBeforePath = change.originalVaultPath ?? change.vaultPath;
        } else {
          delta.sourceAfterPath = change.vaultPath;
        }
        if (resolvedPath) delta.currentResolvedVaultPath = resolvedPath;
        relations.push(delta);
      }
    }

    for (const change of changes) {
      if (change.kind !== "markdown") change.previewStatus = "not-text";
    }
    if (skippedMarkdownFiles > 0) {
      warnings.push(
        tr(`关系与内容预览只分析了 ${analyzedMarkdownFiles}/${markdown.length} 篇 Markdown；其余文件因大小、数量或历史对象不可读而跳过。`, `Link and content preview analysed only ${analyzedMarkdownFiles}/${markdown.length} Markdown notes; the rest were skipped for size, count or unreadable history objects.`)
      );
    }
    if (physicalBoundarySkipped > 0) {
      warnings.push(
        tr(`${physicalBoundarySkipped} 个工作区 Markdown 的物理路径位于 Vault 外，正文未读取。`, `${physicalBoundarySkipped} working copy Markdown files have physical paths outside the vault; their text was not read.`)
      );
    }
    if (skippedRelationChanges > 0) {
      warnings.push(
        tr(`${skippedRelationChanges} 项关系变化超过分析上限，未在本页展开。`, `${skippedRelationChanges} link changes exceed the analysis limit and are not expanded here.`)
      );
    }
    return {
      changes,
      relations,
      warnings,
      analysis: {
        markdownFiles: markdown.length,
        analyzedMarkdownFiles,
        skippedMarkdownFiles,
        analyzedBytes,
        relationChanges: relations.length,
        skippedRelationChanges,
        partial: skippedMarkdownFiles > 0 || skippedRelationChanges > 0,
        limits: { ...WORK_EVENT_ANALYSIS_LIMITS }
      }
    };
  }

  private async readHistoricalContentOrNull(
    repositoryRoot: string,
    commitHash: string,
    repositoryPath: string
  ): Promise<string | null> {
    try {
      return await this.getFileContent(repositoryRoot, commitHash, repositoryPath);
    } catch {
      return null;
    }
  }

  private async getHistoricalObjectSizeOrNull(
    repositoryRoot: string,
    commitHash: string,
    repositoryPath: string
  ): Promise<number | null> {
    try {
      const output = await this.runGit(repositoryRoot, [
        "cat-file",
        "-s",
        `${commitHash}:${repositoryPath}`
      ]);
      const size = Number.parseInt(output.trim(), 10);
      return Number.isFinite(size) && size >= 0 ? size : null;
    } catch {
      return null;
    }
  }

  private isEventLocalRelation(
    target: string,
    sourcePath: string,
    changedPaths: ReadonlySet<string>
  ): boolean {
    const cleanTarget = target
      .replace(/^\/+/, "")
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "");
    if (!cleanTarget) return false;
    const sourceDirectory = path.posix.dirname(sourcePath);
    const relativeTarget = path.posix
      .normalize(path.posix.join(sourceDirectory, cleanTarget))
      .replace(/\.md$/i, "");
    const targetName = path.posix.basename(cleanTarget).toLocaleLowerCase();
    for (const changedPath of changedPaths) {
      const normalized = changedPath.replace(/\\/g, "/");
      const withoutMarkdown = normalized.replace(/\.md$/i, "");
      const lower = withoutMarkdown.toLocaleLowerCase();
      if (
        lower === cleanTarget.toLocaleLowerCase()
        || lower === relativeTarget.toLocaleLowerCase()
        || path.posix.basename(lower) === targetName
      ) return true;
    }
    return false;
  }

  private async isPhysicalVaultPath(vaultRoot: string, vaultPath: string): Promise<boolean> {
    const physicalPath = await this.resolveRealPath(path.resolve(vaultRoot, vaultPath));
    const relative = path.relative(vaultRoot, physicalPath);
    return relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
  }

  private async assertWorkingPreviewUnchanged(
    context: Omit<GitRepositoryContext, "repositoryRelativePath">,
    changes: readonly WorkEventFileChange[]
  ): Promise<void> {
    for (const change of changes) {
      if (change.previewStatus !== "ready" || change.kind !== "markdown") continue;
      const currentFile = this.app.vault.getFileByPath(change.vaultPath);
      if (change.status === "D") {
        if (currentFile) {
          throw new GitCommandError(
            tr("读取期间 Git HEAD 或工作区发生了变化，请重新采样当前未提交工作。", "Git HEAD or the working copy changed while reading; sample the uncommitted work again.")
          );
        }
        continue;
      }
      if (
        !currentFile
        || !await this.isPhysicalVaultPath(context.vaultRoot, change.vaultPath)
      ) {
        throw new GitCommandError(
          tr("读取期间 Git HEAD 或工作区发生了变化，请重新采样当前未提交工作。", "Git HEAD or the working copy changed while reading; sample the uncommitted work again.")
        );
      }
      const currentContent = await this.app.vault.read(currentFile);
      if (currentContent !== change.afterContent) {
        throw new GitCommandError(
          tr("读取期间 Git HEAD 或工作区发生了变化，请重新采样当前未提交工作。", "Git HEAD or the working copy changed while reading; sample the uncommitted work again.")
        );
      }
    }
  }

  private async readWorkingEventGitState(
    repositoryRoot: string,
    comparisonHash: string
  ): Promise<{
    headHash: string;
    status: string;
    nameStatus: string;
    stats: string;
  }> {
    const [headHash, status, nameStatus, stats] = await Promise.all([
      this.runGit(repositoryRoot, ["rev-parse", "HEAD"]).catch(
        (error: unknown) => {
          if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) {
            return "";
          }
          throw error;
        }
      ),
      this.runGit(repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all"
      ]),
      comparisonHash
        ? this.runGit(repositoryRoot, [
            "-c",
            "core.quotePath=false",
            "diff",
            comparisonHash,
            "--find-renames",
            "--find-copies",
            "--name-status",
            "-z",
            "--"
          ])
        : Promise.resolve(""),
      comparisonHash
        ? this.runGit(repositoryRoot, [
            "-c",
            "core.quotePath=false",
            "diff",
            comparisonHash,
            "--find-renames",
            "--find-copies",
            "--numstat",
            "-z",
            "--"
          ])
        : Promise.resolve("")
    ]);
    return {
      headHash: headHash.trim(),
      status,
      nameStatus,
      stats
    };
  }

  private async readOnlyFileState(
    context: GitRepositoryContext
  ): Promise<ReadOnlyFileState> {
    const [headHash, status, branch] = await Promise.all([
      this.runGit(context.repositoryRoot, ["rev-parse", "HEAD"]).catch(
        (error: unknown) => {
          if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) {
            return "";
          }
          throw error;
        }
      ),
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        context.repositoryRelativePath
      ]),
      this.getBranch(context.repositoryRoot)
    ]);
    return {
      branch: branch.trim() || "HEAD",
      headHash: headHash.trim(),
      status
    };
  }

  private async resolveWorkingHistoryAnchor(
    file: TFile,
    context: GitRepositoryContext,
    state: ReadOnlyFileState
  ): Promise<WorkingHistoryAnchor> {
    const currentPath = context.repositoryRelativePath;
    const currentChange = parseWorkspaceStatus(state.status).find(
      (change) => change.path === currentPath
    );
    if (
      currentChange?.indexStatus === "R"
      && currentChange.originalPath
      && this.workEventVaultPath(context, currentChange.originalPath) !== null
    ) {
      return {
        historyPath: currentChange.originalPath,
        workingRename: {
          kind: "staged",
          currentPath,
          originalPath: currentChange.originalPath
        }
      };
    }
    if (currentChange?.indexStatus === "A") {
      const stagedNameStatus = await this.readStagedNameStatus(
        context.repositoryRoot
      );
      const stagedRename = parseCommittedNameStatus(stagedNameStatus).find(
        (change) =>
          change.changeType === "R"
          && change.path === currentPath
          && change.originalPath
      );
      if (
        stagedRename?.originalPath
        && this.workEventVaultPath(context, stagedRename.originalPath) !== null
      ) {
        return {
          historyPath: stagedRename.originalPath,
          workingRename: {
            kind: "staged",
            currentPath,
            originalPath: stagedRename.originalPath
          },
          validationStagedNameStatus: stagedNameStatus
        };
      }
    }
    if (!state.headHash || !currentChange?.untracked) {
      return { historyPath: currentPath };
    }

    const trackedStatusBefore = await this.readTrackedWorkspaceStatus(
      context.repositoryRoot
    );
    const workspace = parseWorkspaceStatus(trackedStatusBefore);
    const deletedCandidates = workspace.filter((change) =>
      change.indexStatus === " "
      && change.workTreeStatus === "D"
      && this.workEventVaultPath(context, change.path) !== null
    );
    if (deletedCandidates.length === 0) {
      return { historyPath: currentPath };
    }
    if (deletedCandidates.length > EXACT_UNSTAGED_RENAME_MAX_CANDIDATES) {
      return {
        historyPath: currentPath,
        renameWarning:
          tr(`检测到超过 ${EXACT_UNSTAGED_RENAME_MAX_CANDIDATES} 个未暂存删除候选，未猜测当前文件的旧路径。`, `More than ${EXACT_UNSTAGED_RENAME_MAX_CANDIDATES} unstaged deletion candidates; the old path of the current file was not guessed.`)
      };
    }

    const capture = await this.captureStableWorkingFile(
      file,
      EXACT_UNSTAGED_RENAME_MAX_BYTES
    );
    if (
      capture.availability !== "ready"
      || capture.headHash !== state.headHash
      || capture.branch !== state.branch
      || capture.status !== state.status
    ) {
      return {
        historyPath: currentPath,
        ...(capture.availability === "too-large"
          ? {
              renameWarning:
                tr(`当前文件超过 ${EXACT_UNSTAGED_RENAME_MAX_BYTES / 1024} KiB，未尝试精确识别未暂存重命名。`, `The current file is over ${EXACT_UNSTAGED_RENAME_MAX_BYTES / 1024} KiB; unstaged renames were not detected exactly.`)
            }
          : {})
      };
    }

    const bytes = Buffer.from(capture.content, "utf8");
    const algorithm = state.headHash.length === 64 ? "sha256" : "sha1";
    const workingBlobHash = createHash(algorithm)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    const matches: string[] = [];
    for (const candidate of deletedCandidates) {
      const objectHash = (await this.runGit(context.repositoryRoot, [
        "rev-parse",
        `${state.headHash}:${candidate.path}`
      ]).catch(() => "")).trim();
      if (objectHash === workingBlobHash) matches.push(candidate.path);
    }
    const trackedStatusAfter = await this.readTrackedWorkspaceStatus(
      context.repositoryRoot
    );
    if (trackedStatusAfter !== trackedStatusBefore) {
      return {
        historyPath: currentPath,
        renameWarning: tr("识别旧路径期间工作区状态发生了变化，未猜测重命名关系。", "The working copy changed while finding the old path; no rename was guessed.")
      };
    }
    if (matches.length === 1) {
      const originalPath = matches[0]!;
      return {
        historyPath: originalPath,
        workingRename: {
          kind: "exact-unstaged",
          currentPath,
          originalPath
        },
        anchorWorkingFingerprint: capture.beforeFingerprint,
        validationTrackedStatus: trackedStatusAfter
      };
    }
    if (matches.length > 1) {
      return {
        historyPath: currentPath,
        renameWarning: tr("存在多个内容完全相同的旧路径候选，未猜测当前文件来自哪一篇笔记。", "Several old paths have identical content; which note this came from was not guessed.")
      };
    }
    return {
      historyPath: currentPath,
      renameWarning:
        tr("检测到未暂存删除候选，但当前内容已变或无法唯一确认旧路径，未猜测重命名关系。", "Unstaged deletion candidates exist, but the content changed or the old path is not unique; no rename was guessed.")
    };
  }

  private readTrackedWorkspaceStatus(repositoryRoot: string): Promise<string> {
    return this.runGit(repositoryRoot, [
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no"
    ]);
  }

  private readStagedNameStatus(repositoryRoot: string): Promise<string> {
    return this.runGit(repositoryRoot, [
      "-c",
      "core.quotePath=false",
      "diff",
      "--cached",
      "--find-renames",
      "--diff-filter=R",
      "--name-status",
      "-z",
      "--"
    ]).catch((error: unknown) => {
      if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) {
        return "";
      }
      throw error;
    });
  }

  private async getEmptyTreeHash(repositoryRoot: string): Promise<string> {
    const hash = (await this.runGit(
      repositoryRoot,
      ["hash-object", "-t", "tree", "--stdin"],
      ""
    )).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(hash)) {
      throw new GitCommandError(tr("无法计算当前 Git 仓库格式对应的空目录对象。", "Could not compute the empty tree object for this repository format."));
    }
    return hash;
  }

  private async resolveContext(file: TFile): Promise<GitRepositoryContext> {
    return this.resolveVaultPathContext(file.path);
  }

  private async resolveRepository(): Promise<{ vaultRoot: string; repositoryRoot: string }> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new GitCommandError(tr("当前库不在桌面文件系统上，无法调用本机 Git。", "This vault is not on a desktop file system, so local Git cannot run."), "", "not-desktop");
    }
    const unresolvedVaultRoot = path.resolve(adapter.getBasePath());
    const vaultRoot = await this.resolveRealPath(unresolvedVaultRoot);
    const configuredRoot = this.getSettings().repositoryRoot.trim();
    const unresolvedRepositoryRoot = configuredRoot
      ? path.resolve(configuredRoot)
      : (await this.runGit(unresolvedVaultRoot, ["rev-parse", "--show-toplevel"])).trim();
    const repositoryRoot = await this.resolveRealPath(unresolvedRepositoryRoot);
    if (!repositoryRoot) throw new GitCommandError(tr("没有找到 Git 仓库根目录。", "No Git repository root was found."), "", "not-repo");
    return { vaultRoot, repositoryRoot };
  }

  private async resolveRealPath(value: string): Promise<string> {
    if (!value) return "";
    try {
      return await realpath(value);
    } catch {
      return path.resolve(value);
    }
  }

  private async getWorkingTreeStats(
    context: GitRepositoryContext,
    untracked: boolean,
    file: TFile
  ): Promise<GitLineStats> {
    if (untracked) {
      const content = await this.app.vault.read(file);
      return {
        addedLines: content === "" ? 0 : content.split(/\r?\n/).length,
        deletedLines: 0
      };
    }
    try {
      const output = await this.runGit(context.repositoryRoot, [
        "diff",
        "HEAD",
        "--numstat",
        "--",
        context.repositoryRelativePath
      ]);
      return parseSingleNumStat(output);
    } catch (error) {
      if (error instanceof GitCommandError && this.isEmptyRepositoryError(error.stderr)) {
        return { addedLines: 0, deletedLines: 0 };
      }
      throw error;
    }
  }

  private runGit(cwd: string, args: string[], input?: string): Promise<string> {
    const executable = this.getSettings().gitExecutable.trim() || "git";

    return new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        ["-C", cwd, ...args],
        {
          encoding: "utf8",
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          timeout: GIT_COMMAND_TIMEOUT_MS,
          windowsHide: true,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_NO_LAZY_FETCH: "1",
            GIT_PAGER: "cat"
          }
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }

          const detail = stderr.trim() || error.message;
          if ((error as { killed?: boolean }).killed) {
            reject(new GitCommandError(
              tr(`Git 命令超过 ${GIT_COMMAND_TIMEOUT_MS / 1000} 秒未完成，已停止。`, `A Git command took longer than ${GIT_COMMAND_TIMEOUT_MS / 1000} seconds and was stopped.`),
              detail,
              "timeout"
            ));
            return;
          }
          if (/not a git repository/i.test(detail)) {
            reject(new GitCommandError(tr("这个库不在 Git 仓库里。", "This vault is not inside a Git repository."), detail, "not-repo"));
            return;
          }
          if (/ENOENT/.test(error.message)) {
            reject(new GitCommandError(tr(`找不到 Git 程序：${executable}`, `Git was not found: ${executable}`), detail, "no-git"));
            return;
          }
          reject(new GitCommandError(tr("Git 命令执行失败。", "A Git command failed."), detail));
        }
      );
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  private async getBranch(repositoryRoot: string): Promise<string> {
    try {
      return await this.runGit(repositoryRoot, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
      try {
        return await this.runGit(repositoryRoot, ["rev-parse", "--short", "HEAD"]);
      } catch {
        return tr("尚无提交", "No commits yet");
      }
    }
  }

  /** Read-only checks that tell apart "no commits at all", "not tracked", "ignored" and "tracked but never committed". */
  private async explainEmptyHistory(
    context: GitRepositoryContext,
    status: GitFileStatus
  ): Promise<{ reason: GitEmptyHistoryReason; rule?: string }> {
    const hasHead = await this.runGit(context.repositoryRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
    if (!hasHead) return { reason: "no-commits" };
    if (status.untracked) return { reason: "untracked" };
    const ignored = await this.runGit(context.repositoryRoot, ["check-ignore", "-v", "--", context.repositoryRelativePath]).catch(() => "");
    if (ignored.trim()) return { reason: "ignored", rule: ignored.split("\t")[0]?.trim() ?? "" };
    if (status.staged) return { reason: "staged" };
    return { reason: "no-history" };
  }

  private isEmptyRepositoryError(stderr: string): boolean {
    return /does not have any commits|your current branch .* has no commits|bad revision ['"]?HEAD|ambiguous argument ['"]?HEAD['"]?: unknown revision or path|needed a single revision/i.test(
      stderr
    );
  }
}
