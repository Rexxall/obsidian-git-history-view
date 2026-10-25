import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileSystemAdapter } from "obsidian";
import type { App, TFile } from "obsidian";
import { GitClient } from "../src/git/git-client";
import type { GitNoteHistorySettings } from "../src/models";

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly root: string) {
    super();
  }

  getBasePath(): string {
    return this.root;
  }
}

const settings: GitNoteHistorySettings = {
  gitExecutable: "git",
  repositoryRoot: "",
  maxCommits: 100,
  showAuthorEmail: false,
  followActiveNote: true,
  defaultDetailMode: "side-by-side",
  density: "comfortable",
  ignoreWhitespace: false,
  showCommitStats: true,
  reviewExcludedPaths: [],
  sandboxStorageRoot: "",
  historySignalProfile: "balanced",
  historyIgnoredProperties: [],
  historyGeneratedProperties: [],
  useBlameIgnoreRevs: true,
  showLabTools: false
};

const repositories: string[] = [];

function git(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  input?: string
): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    ...(input === undefined ? {} : { input })
  });
}

function createRepository(objectFormat?: "sha256"): string {
  const repository = mkdtempSync(path.join(tmpdir(), "git-note-work-event-edge-"));
  repositories.push(repository);
  git(repository, [
    "init",
    "-q",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : [])
  ]);
  git(repository, ["config", "user.name", "Work Event Edge Test"]);
  git(repository, ["config", "user.email", "work-event-edge@example.com"]);
  return repository;
}

function supportsSha256Repositories(): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), "git-note-sha256-probe-"));
  try {
    execFileSync("git", [
      "init",
      "-q",
      "--object-format=sha256",
      probe
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const SHA256_REPOSITORIES_SUPPORTED = supportsSha256Repositories();

function writeText(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function commit(
  repository: string,
  subject: string,
  committedAt?: string,
  allowEmpty = false
): string {
  git(repository, ["add", "-A"]);
  const dateEnvironment = committedAt
    ? {
        GIT_AUTHOR_DATE: committedAt,
        GIT_COMMITTER_DATE: committedAt
      }
    : {};
  git(repository, [
    "commit",
    "-q",
    ...(allowEmpty ? ["--allow-empty"] : []),
    "-m",
    subject
  ], dateEnvironment);
  return git(repository, ["rev-parse", "HEAD"]).trim();
}

function fakeApp(
  vaultRoot: string,
  onRead?: (vaultPath: string) => void
): App {
  return {
    vault: {
      adapter: new TestFileSystemAdapter(vaultRoot),
      getFileByPath: (vaultPath: string) => {
        const absolutePath = path.resolve(vaultRoot, vaultPath);
        const relativePath = path.relative(vaultRoot, absolutePath);
        const insideVault =
          relativePath !== ".."
          && !relativePath.startsWith(`..${path.sep}`)
          && !path.isAbsolute(relativePath);
        if (!insideVault || !existsSync(absolutePath)) return null;
        const fileStat = statSync(absolutePath);
        if (!fileStat.isFile()) return null;
        return {
          path: vaultPath,
          stat: {
            ctime: fileStat.ctimeMs,
            mtime: fileStat.mtimeMs,
            size: fileStat.size
          }
        } as TFile;
      },
      read: async (file: TFile) => {
        onRead?.(file.path);
        return readFileSync(path.join(vaultRoot, file.path), "utf8");
      }
    },
    metadataCache: {
      getFirstLinkpathDest: () => null
    }
  } as unknown as App;
}

function clientFor(
  vaultRoot: string,
  onRead?: (vaultPath: string) => void
): GitClient {
  return new GitClient(fakeApp(vaultRoot, onRead), () => settings);
}

type InternalGitClient = {
  runGit: (cwd: string, args: string[], input?: string) => Promise<string>;
};

function observeGitCalls(client: GitClient): string[][] {
  const internal = client as unknown as InternalGitClient;
  const originalRunGit = internal.runGit.bind(client);
  const calls: string[][] = [];
  internal.runGit = async (cwd, args, input) => {
    calls.push([...args]);
    return originalRunGit(cwd, args, input);
  };
  return calls;
}

afterEach(() => {
  while (repositories.length > 0) {
    const repository = repositories.pop();
    if (repository) rmSync(repository, { recursive: true, force: true });
  }
});

describe("GitClient.loadWorkEvent edge cases with real Git repositories", () => {
  it("uses a merge commit's first parent as the exact base and never infers a session", async () => {
    const repository = createRepository();
    writeText(repository, "Notes/Baseline.md", "# Baseline\n");
    commit(repository, "Baseline", "2026-07-29T09:00:00+09:00");
    const mainBranch = git(repository, ["branch", "--show-current"]).trim();

    git(repository, ["checkout", "-q", "-b", "feature"]);
    writeText(repository, "Notes/From feature.md", "# Feature\n");
    const featureHash = commit(
      repository,
      "Feature work",
      "2026-07-29T09:10:00+09:00"
    );

    git(repository, ["checkout", "-q", mainBranch]);
    writeText(repository, "Notes/From main.md", "# Main\n");
    const firstParentHash = commit(
      repository,
      "Main work",
      "2026-07-29T09:15:00+09:00"
    );
    git(repository, [
      "merge",
      "-q",
      "--no-ff",
      "feature",
      "-m",
      "Merge feature"
    ], {
      GIT_AUTHOR_DATE: "2026-07-29T09:20:00+09:00",
      GIT_COMMITTER_DATE: "2026-07-29T09:20:00+09:00"
    });
    const mergeHash = git(repository, ["rev-parse", "HEAD"]).trim();

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: "Notes/From feature.md",
      source: {
        kind: "commit",
        commitHash: mergeHash,
        aggregation: "session"
      }
    });

    expect(snapshot).toMatchObject({
      source: "git-commit",
      confidence: "exact",
      aggregation: "session",
      baseHash: firstParentHash,
      headHash: mergeHash
    });
    expect(snapshot.commits).toHaveLength(1);
    expect(snapshot.commits[0]?.parentHashes).toEqual([
      firstParentHash,
      featureHash
    ]);
    expect(snapshot.netChanges).toEqual([
      expect.objectContaining({
        status: "A",
        vaultPath: "Notes/From feature.md",
        isAnchor: true
      })
    ]);
    expect(snapshot.warnings.join("\n")).not.toContain("推测");
  });

  it("caps a 13-plus automatic-backup chain at 12 commits and warns that it may start earlier", async () => {
    const repository = createRepository();
    const notePath = "Notes/Long session.md";
    writeText(repository, notePath, "# Session\n\nBaseline.\n");
    commit(repository, "Manual baseline", "2026-07-29T10:00:00+09:00");

    const backupHashes: string[] = [];
    for (let index = 1; index <= 13; index += 1) {
      writeText(
        repository,
        notePath,
        `# Session\n\n${Array.from(
          { length: index },
          (_, line) => `Pass ${line + 1}.`
        ).join("\n")}\n`
      );
      backupHashes.push(commit(
        repository,
        `Mac Backup: pass ${index}`,
        `2026-07-29T10:${String(index).padStart(2, "0")}:00+09:00`
      ));
    }

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: notePath,
      source: {
        kind: "commit",
        commitHash: backupHashes.at(-1)!,
        aggregation: "session"
      }
    });

    expect(snapshot).toMatchObject({
      source: "git-session",
      confidence: "heuristic",
      headHash: backupHashes.at(-1),
      baseHash: backupHashes[0]
    });
    expect(snapshot.commits).toHaveLength(12);
    expect(snapshot.commits.map((item) => item.hash)).toEqual(
      backupHashes.slice(1).reverse()
    );
    expect(snapshot.warnings).toContain(
      "这组自动备份已达到 12 个提交上限，会话可能从更早开始。"
    );
  }, 15_000);

  it("keeps a file visible as netUnchanged when a backup session modifies and then restores it", async () => {
    const repository = createRepository();
    const notePath = "Notes/Round trip.md";
    const baseline = "# Round trip\n\nOriginal.\n";
    writeText(repository, notePath, baseline);
    const baselineHash = commit(
      repository,
      "Manual baseline",
      "2026-07-29T11:00:00+09:00"
    );

    writeText(repository, notePath, "# Round trip\n\nTemporary edit.\n");
    commit(
      repository,
      "Vault Backup: temporary edit",
      "2026-07-29T11:10:00+09:00"
    );
    writeText(repository, notePath, baseline);
    const restoredHash = commit(
      repository,
      "Vault Backup: restore original",
      "2026-07-29T11:20:00+09:00"
    );

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: notePath,
      source: {
        kind: "commit",
        commitHash: restoredHash,
        aggregation: "session"
      }
    });

    expect(snapshot.baseHash).toBe(baselineHash);
    expect(snapshot.netChanges).toEqual([
      expect.objectContaining({
        status: "M",
        vaultPath: notePath,
        isAnchor: true,
        netUnchanged: true,
        beforeContent: baseline,
        afterContent: baseline,
        previewStatus: "ready"
      })
    ]);
    expect(snapshot.warnings).toContain(
      "1 个文件在会话中曾修改，但结束时回到了起点内容。"
    );
  });

  it("marks oversized Markdown partial before issuing any git show for its blob", async () => {
    const repository = createRepository();
    const notePath = "Notes/Oversized.md";
    const largeBody = `${"large historical line\n".repeat(14_000)}baseline\n`;
    writeText(repository, notePath, largeBody);
    commit(repository, "Large baseline");
    writeText(repository, notePath, `${largeBody}changed\n`);
    const eventHash = commit(repository, "Change large note");
    const client = clientFor(repository);
    const gitCalls = observeGitCalls(client);

    const snapshot = await client.loadWorkEvent({
      anchorVaultPath: notePath,
      source: {
        kind: "commit",
        commitHash: eventHash,
        aggregation: "commit"
      }
    });
    const change = snapshot.netChanges[0];
    const contentShowCalls = gitCalls.filter((args) =>
      args[0] === "show"
      && args.some((arg) => arg.endsWith(`:${notePath}`))
    );

    expect(change).toMatchObject({
      vaultPath: notePath,
      previewStatus: "too-large"
    });
    expect(change?.beforeContent).toBeUndefined();
    expect(change?.afterContent).toBeUndefined();
    expect(snapshot.analysis).toMatchObject({
      markdownFiles: 1,
      analyzedMarkdownFiles: 0,
      skippedMarkdownFiles: 1,
      analyzedBytes: 0,
      partial: true
    });
    expect(gitCalls.filter((args) => args[0] === "cat-file")).toHaveLength(2);
    expect(contentShowCalls).toEqual([]);
  });

  it("returns explicit empty snapshots for an allow-empty commit and a clean working tree", async () => {
    const repository = createRepository();
    writeText(repository, "Notes/Stable.md", "# Stable\n");
    commit(repository, "Baseline");
    const emptyHash = commit(repository, "Metadata-only checkpoint", undefined, true);
    const client = clientFor(repository);

    const committed = await client.loadWorkEvent({
      source: {
        kind: "commit",
        commitHash: emptyHash,
        aggregation: "commit"
      }
    });
    const working = await client.loadWorkEvent({
      source: { kind: "working" }
    });

    expect(committed).toMatchObject({
      source: "git-commit",
      confidence: "exact",
      headHash: emptyHash,
      netChanges: [],
      relationDeltas: [],
      analysis: {
        markdownFiles: 0,
        analyzedMarkdownFiles: 0,
        skippedMarkdownFiles: 0,
        partial: false
      }
    });
    expect(committed.commitSlices).toEqual([
      expect.objectContaining({
        changes: [],
        hiddenRepositoryFileCount: 0
      })
    ]);
    expect(working).toMatchObject({
      source: "working",
      confidence: "snapshot",
      baseHash: emptyHash,
      headHash: emptyHash,
      netChanges: [],
      relationDeltas: [],
      hiddenRepositoryFileCount: 0,
      warnings: []
    });
  });

  it("loads untracked Markdown from an unborn repository without inventing a HEAD", async () => {
    const repository = createRepository();
    const notePath = "Notes/First note.md";
    writeText(repository, notePath, "# First note\n\nNo commits yet.\n");

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: notePath,
      source: { kind: "working" }
    });

    expect(snapshot.id).toContain("working:unborn:");
    expect(snapshot.baseHash).toBeUndefined();
    expect(snapshot.headHash).toBeUndefined();
    expect(snapshot.netChanges).toEqual([
      expect.objectContaining({
        status: "A",
        vaultPath: notePath,
        isAnchor: true,
        untracked: true,
        beforeContent: "",
        afterContent: "# First note\n\nNo commits yet.\n",
        previewStatus: "ready"
      })
    ]);
  });

  it("includes staged additions from an unborn repository", async () => {
    const repository = createRepository();
    const stagedPath = "Notes/Staged first note.md";
    const mixedPath = "Notes/Staged then edited.md";
    writeText(repository, stagedPath, "# Staged first note\n");
    writeText(repository, mixedPath, "# Staged then edited\n\nStaged.\n");
    git(repository, ["add", stagedPath, mixedPath]);
    writeText(repository, mixedPath, "# Staged then edited\n\nWorking copy.\n");

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: stagedPath,
      source: { kind: "working" }
    });

    expect(snapshot.id).toContain("working:unborn:");
    expect(snapshot.baseHash).toBeUndefined();
    expect(snapshot.headHash).toBeUndefined();
    expect(snapshot.netChanges).toHaveLength(2);
    expect(snapshot.netChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "A",
        vaultPath: stagedPath,
        isAnchor: true,
        beforeContent: "",
        afterContent: "# Staged first note\n",
        previewStatus: "ready"
      }),
      expect.objectContaining({
        status: "A",
        vaultPath: mixedPath,
        beforeContent: "",
        afterContent: "# Staged then edited\n\nWorking copy.\n",
        previewStatus: "ready"
      })
    ]));
    expect(snapshot.netChanges.every((change) => !change.untracked)).toBe(true);
  });

  it("rejects a working snapshot when Markdown changes without changing porcelain status", async () => {
    const repository = createRepository();
    const notePath = "Notes/Race.md";
    writeText(repository, notePath, "# Race\n\nBaseline.\n");
    commit(repository, "Baseline");
    const firstWorkingCopy = "# Race\n\nversion one\n";
    const secondWorkingCopy = "# Race\n\nversion two\n";
    writeText(repository, notePath, firstWorkingCopy);
    let reads = 0;
    const client = clientFor(repository, (vaultPath) => {
      if (vaultPath !== notePath) return;
      reads += 1;
      if (reads === 2) writeText(repository, notePath, secondWorkingCopy);
    });

    await expect(client.loadWorkEvent({
      anchorVaultPath: notePath,
      source: { kind: "working" }
    })).rejects.toThrow(
      "读取期间 Git HEAD 或工作区发生了变化，请重新采样当前未提交工作。"
    );
    expect(reads).toBe(2);
    expect(readFileSync(path.join(repository, notePath), "utf8")).toBe(
      secondWorkingCopy
    );
  });

  it("rejects a working snapshot when HEAD changes during preview verification", async () => {
    const repository = createRepository();
    const notePath = "Notes/Concurrent commit.md";
    writeText(repository, notePath, "# Concurrent commit\n\nBaseline.\n");
    commit(repository, "Baseline");
    const workingCopy = "# Concurrent commit\n\nReady to commit.\n";
    writeText(repository, notePath, workingCopy);
    let reads = 0;
    const client = clientFor(repository, (vaultPath) => {
      if (vaultPath !== notePath) return;
      reads += 1;
      if (reads === 2) commit(repository, "Concurrent commit");
    });

    await expect(client.loadWorkEvent({
      anchorVaultPath: notePath,
      source: { kind: "working" }
    })).rejects.toThrow(
      "读取期间 Git HEAD 或工作区发生了变化，请重新采样当前未提交工作。"
    );
    expect(reads).toBe(2);
    expect(readFileSync(path.join(repository, notePath), "utf8")).toBe(
      workingCopy
    );
  });

  it("hides a real Git copy from a nested Vault to a repository-only path", async () => {
    const repository = createRepository();
    const vaultRoot = path.join(repository, "Vault");
    const sourcePath = "Vault/Notes/Source.md";
    const sourceContent = [
      "# Source",
      "",
      ...Array.from({ length: 40 }, (_, index) => `Stable line ${index + 1}.`)
    ].join("\n");
    writeText(repository, sourcePath, `${sourceContent}\n`);
    const baselineHash = commit(repository, "Baseline");

    const privatePath = "Private/Copy.md";
    const privateAbsolutePath = path.join(repository, privatePath);
    mkdirSync(path.dirname(privateAbsolutePath), { recursive: true });
    copyFileSync(path.join(repository, sourcePath), privateAbsolutePath);
    writeText(repository, sourcePath, `${sourceContent}\n\nVault-only edit.\n`);
    const eventHash = commit(repository, "Copy source outside Vault");
    const rawNameStatus = git(repository, [
      "diff",
      "--find-copies",
      "--name-status",
      "-z",
      baselineHash,
      eventHash,
      "--"
    ]);
    expect(rawNameStatus).toContain(`\0${sourcePath}\0${privatePath}\0`);

    const readPaths: string[] = [];
    const snapshot = await clientFor(
      vaultRoot,
      (vaultPath) => readPaths.push(vaultPath)
    ).loadWorkEvent({
      anchorVaultPath: "Notes/Source.md",
      source: {
        kind: "commit",
        commitHash: eventHash,
        aggregation: "commit"
      }
    });

    expect(snapshot.netChanges).toEqual([
      expect.objectContaining({
        status: "M",
        repositoryPath: sourcePath,
        vaultPath: "Notes/Source.md"
      })
    ]);
    expect(snapshot.hiddenRepositoryFileCount).toBe(1);
    expect(snapshot.commitSlices[0]?.hiddenRepositoryFileCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("Private/Copy.md");
    expect(readPaths).not.toContain(privatePath);
  });

  it.skipIf(process.platform === "win32")(
    "does not read working Markdown through a symlink whose physical target is outside the Vault",
    async () => {
      const repository = createRepository();
      const vaultRoot = path.join(repository, "Vault");
      writeText(repository, "Vault/Notes/Baseline.md", "# Baseline\n");
      commit(repository, "Baseline");
      writeText(repository, "Private/Secret.md", "# Secret\n\nOutside Vault.\n");
      const linkPath = "Notes/External.md";
      const absoluteLinkPath = path.join(vaultRoot, linkPath);
      mkdirSync(path.dirname(absoluteLinkPath), { recursive: true });
      symlinkSync("../../Private/Secret.md", absoluteLinkPath);
      const readPaths: string[] = [];

      const snapshot = await clientFor(
        vaultRoot,
        (vaultPath) => {
          readPaths.push(vaultPath);
          if (vaultPath === linkPath) {
            throw new Error("The symlink target must never be read.");
          }
        }
      ).loadWorkEvent({
        anchorVaultPath: linkPath,
        source: { kind: "working" }
      });

      expect(snapshot.netChanges).toEqual([
        expect.objectContaining({
          status: "A",
          vaultPath: linkPath,
          isAnchor: true,
          untracked: true,
          openable: false,
          previewStatus: "unavailable"
        })
      ]);
      expect(snapshot.analysis).toMatchObject({
        markdownFiles: 1,
        analyzedMarkdownFiles: 0,
        skippedMarkdownFiles: 1,
        partial: true
      });
      expect(snapshot.warnings).toContain(
        "1 个工作区 Markdown 的物理路径位于 Vault 外，正文未读取。"
      );
      expect(readPaths).not.toContain(linkPath);
    }
  );

  it("collapses a staged rename followed by a working-tree deletion into the final deletion", async () => {
    const repository = createRepository();
    const oldPath = "Notes/Before.md";
    const newPath = "Notes/After.md";
    writeText(repository, oldPath, "# Rename then delete\n");
    const headHash = commit(repository, "Baseline");
    git(repository, ["mv", oldPath, newPath]);
    rmSync(path.join(repository, newPath));

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: oldPath,
      source: { kind: "working" }
    });

    expect(snapshot).toMatchObject({
      baseHash: headHash,
      headHash
    });
    expect(snapshot.netChanges).toEqual([
      expect.objectContaining({
        status: "D",
        repositoryPath: oldPath,
        vaultPath: oldPath,
        isAnchor: true,
        afterContent: "",
        previewStatus: "ready"
      })
    ]);
    expect(snapshot.netChanges[0]?.originalRepositoryPath).toBeUndefined();
    expect(JSON.stringify(snapshot.netChanges)).not.toContain(newPath);
  });

  it.skipIf(!SHA256_REPOSITORIES_SUPPORTED)(
    "derives the repository-format empty tree when loading a SHA-256 root commit",
    async () => {
      const repository = createRepository("sha256");
      const notePath = "Notes/SHA-256 root.md";
      writeText(repository, notePath, "# SHA-256 root\n");
      const rootHash = commit(repository, "SHA-256 root commit");
      const emptyTreeHash = git(
        repository,
        ["hash-object", "-t", "tree", "--stdin"],
        {},
        ""
      ).trim();
      const client = clientFor(repository);
      const gitCalls = observeGitCalls(client);

      const snapshot = await client.loadWorkEvent({
        anchorVaultPath: notePath,
        source: {
          kind: "commit",
          commitHash: rootHash,
          aggregation: "commit"
        }
      });

      expect(rootHash).toHaveLength(64);
      expect(emptyTreeHash).toHaveLength(64);
      expect(snapshot.baseHash).toBeUndefined();
      expect(snapshot.headHash).toBe(rootHash);
      expect(snapshot.netChanges).toEqual([
        expect.objectContaining({
          status: "A",
          vaultPath: notePath,
          beforeContent: "",
          afterContent: "# SHA-256 root\n",
          previewStatus: "ready"
        })
      ]);
      expect(gitCalls).toEqual(expect.arrayContaining([
        ["hash-object", "-t", "tree", "--stdin"]
      ]));
      expect(gitCalls.filter((args) => args.includes(emptyTreeHash))).toHaveLength(2);
    }
  );
});
