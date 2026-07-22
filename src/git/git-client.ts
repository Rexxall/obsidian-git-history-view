import { execFile } from "node:child_process";
import path from "node:path";
import { App, FileSystemAdapter, TFile } from "obsidian";
import type {
  GitCommitVersion,
  GitConflictVersions,
  GitFileHistory,
  GitLineStats,
  GitNoteHistorySettings,
  GitRepositoryContext,
  GitWorkspaceReview,
  VersionReference
} from "../models";
import {
  parseGitLog,
  parseGitStatus,
  parseNumStatByPath,
  parseNumStatLog,
  parseSingleNumStat,
  parseWorkspaceStatus
} from "./parse-log";

const LOG_FORMAT = "%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B%x1d";
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

export class GitCommandError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr = "") {
    super(message);
    this.name = "GitCommandError";
    this.stderr = stderr;
  }
}

export class GitClient {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => GitNoteHistorySettings
  ) {}

  async loadFileHistory(file: TFile): Promise<GitFileHistory> {
    const context = await this.resolveContext(file);
    const settings = this.getSettings();
    const maxCommits = Math.max(1, Math.min(1000, Math.trunc(settings.maxCommits)));

    const [logOutput, numStatOutput, statusOutput, branchOutput] = await Promise.all([
      this.runGit(context.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "log",
        "--follow",
        "--find-renames",
        `--max-count=${maxCommits}`,
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
        `--max-count=${maxCommits}`,
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

    const commits = parseGitLog(logOutput, context.repositoryRelativePath);
    const stats = parseNumStatLog(numStatOutput);
    for (const commit of commits) {
      const commitStats = stats.get(commit.hash);
      if (!commitStats) continue;
      commit.addedLines = commitStats.addedLines;
      commit.deletedLines = commitStats.deletedLines;
    }

    const status = parseGitStatus(statusOutput);
    const workingTreeStats = await this.getWorkingTreeStats(context, status.untracked, file);

    return {
      context,
      branch: branchOutput.trim() || "HEAD",
      status,
      commits,
      workingTreeStats
    };
  }

  async getFileContent(
    repositoryRoot: string,
    commitHash: string,
    historicalPath: string
  ): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(commitHash)) {
      throw new GitCommandError("Git 提交哈希格式无效。");
    }

    return this.runGit(repositoryRoot, ["show", `${commitHash}:${historicalPath}`]);
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
      this.runGit(repositoryRoot, ["diff", "HEAD", "--numstat", "--"]).catch(
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
    if (!hash) throw new GitCommandError("Git 中没有找到可恢复的文件版本。");
    const content = await this.getFileContent(repositoryRoot, hash, repositoryPath);
    return { hash, content };
  }

  async resolveFileContext(file: TFile): Promise<GitRepositoryContext> {
    return this.resolveContext(file);
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
      throw new GitCommandError("当前笔记没有 Git 索引冲突。");
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

  private async resolveContext(file: TFile): Promise<GitRepositoryContext> {
    const { vaultRoot, repositoryRoot } = await this.resolveRepository();

    const absoluteFilePath = path.resolve(vaultRoot, file.path);
    const repositoryRelativePath = path.relative(repositoryRoot, absoluteFilePath);
    if (
      repositoryRelativePath === "" ||
      repositoryRelativePath.startsWith(`..${path.sep}`) ||
      repositoryRelativePath === ".." ||
      path.isAbsolute(repositoryRelativePath)
    ) {
      throw new GitCommandError("当前笔记不在检测到的 Git 仓库中。");
    }

    return {
      vaultRoot,
      repositoryRoot,
      repositoryRelativePath: repositoryRelativePath.split(path.sep).join("/")
    };
  }

  private async resolveRepository(): Promise<{ vaultRoot: string; repositoryRoot: string }> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new GitCommandError("当前 Vault 不是桌面文件系统，无法调用本机 Git。");
    }
    const vaultRoot = path.resolve(adapter.getBasePath());
    const configuredRoot = this.getSettings().repositoryRoot.trim();
    const repositoryRoot = configuredRoot
      ? path.resolve(configuredRoot)
      : (await this.runGit(vaultRoot, ["rev-parse", "--show-toplevel"])).trim();
    if (!repositoryRoot) throw new GitCommandError("没有找到 Git 仓库根目录。");
    return { vaultRoot, repositoryRoot };
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

  private runGit(cwd: string, args: string[]): Promise<string> {
    const executable = this.getSettings().gitExecutable.trim() || "git";

    return new Promise((resolve, reject) => {
      execFile(
        executable,
        ["-C", cwd, ...args],
        {
          encoding: "utf8",
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          windowsHide: true,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_PAGER: "cat"
          }
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }

          const detail = stderr.trim() || error.message;
          if (/not a git repository/i.test(detail)) {
            reject(new GitCommandError("这个 Vault 不在 Git 仓库中。", detail));
            return;
          }
          if (/ENOENT/.test(error.message)) {
            reject(new GitCommandError(`找不到 Git 可执行文件：${executable}`, detail));
            return;
          }
          reject(new GitCommandError("Git 命令执行失败。", detail));
        }
      );
    });
  }

  private async getBranch(repositoryRoot: string): Promise<string> {
    try {
      return await this.runGit(repositoryRoot, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
      try {
        return await this.runGit(repositoryRoot, ["rev-parse", "--short", "HEAD"]);
      } catch {
        return "尚无提交";
      }
    }
  }

  private isEmptyRepositoryError(stderr: string): boolean {
    return /does not have any commits|your current branch .* has no commits|bad revision ['\"]?HEAD/i.test(
      stderr
    );
  }
}
