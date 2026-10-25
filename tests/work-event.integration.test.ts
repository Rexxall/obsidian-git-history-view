import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
  showLabTools: false,
  paperStyle: false,
};

const repositories: string[] = [];

function createRepository(): string {
  const repository = mkdtempSync(path.join(tmpdir(), "git-note-work-event-"));
  repositories.push(repository);
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "Work Event Test"]);
  git(repository, ["config", "user.email", "work-event@example.com"]);
  return repository;
}

function git(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {}
): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
}

function writeText(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function writeBinary(root: string, relativePath: string, content: number[]): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, Buffer.from(content));
}

function commit(
  repository: string,
  subject: string,
  committedAt?: string
): string {
  git(repository, ["add", "-A"]);
  const dateEnvironment = committedAt
    ? {
        GIT_AUTHOR_DATE: committedAt,
        GIT_COMMITTER_DATE: committedAt
      }
    : {};
  git(repository, ["commit", "-q", "-m", subject], dateEnvironment);
  return git(repository, ["rev-parse", "HEAD"]).trim();
}

function fakeApp(vaultRoot: string): App {
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
        return insideVault
          && existsSync(absolutePath)
          && statSync(absolutePath).isFile()
          ? { path: vaultPath } as TFile
          : null;
      },
      read: async (file: TFile) =>
        readFileSync(path.join(vaultRoot, file.path), "utf8")
    },
    metadataCache: {
      getFirstLinkpathDest: () => null
    }
  } as unknown as App;
}

function clientFor(vaultRoot: string): GitClient {
  return new GitClient(fakeApp(vaultRoot), () => settings);
}

afterEach(() => {
  while (repositories.length > 0) {
    const repository = repositories.pop();
    if (repository) rmSync(repository, { recursive: true, force: true });
  }
});

describe("GitClient.loadWorkEvent with a real Git Vault", () => {
  it("loads one exact commit with a renamed note, binary attachment, and relation deltas", async () => {
    const repository = createRepository();
    const oldPath = "Notes/旧名字.md";
    const newPath = "Notes/研究 🧠/新しい名前.md";
    const stableLines = Array.from(
      { length: 12 },
      (_, index) => `保留的上下文 ${index + 1}`
    ).join("\n");
    writeText(
      repository,
      oldPath,
      `# 项目\n\n${stableLines}\n\n[[旧目标]]\n`
    );
    writeText(repository, "Notes/旧目标.md", "# 旧目标\n");
    writeText(repository, "Notes/新目标.md", "# 新目标\n");
    commit(repository, "Baseline");

    const oldAbsolutePath = path.join(repository, oldPath);
    const newAbsolutePath = path.join(repository, newPath);
    mkdirSync(path.dirname(newAbsolutePath), { recursive: true });
    renameSync(oldAbsolutePath, newAbsolutePath);
    writeText(
      repository,
      newPath,
      `# 项目\n\n${stableLines}\n\n[[新目标]]\n`
    );
    writeBinary(
      repository,
      "Attachments/证据 🧠.png",
      [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]
    );
    const eventHash = commit(repository, "Update research note");

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: newPath,
      anchorHistoricalPath: newPath,
      source: {
        kind: "commit",
        commitHash: eventHash,
        aggregation: "commit"
      }
    });
    const renamed = snapshot.netChanges.find((change) => change.status === "R");
    const attachment = snapshot.netChanges.find(
      (change) => change.vaultPath === "Attachments/证据 🧠.png"
    );

    expect(snapshot).toMatchObject({
      source: "git-commit",
      confidence: "exact",
      aggregation: "commit",
      headHash: eventHash,
      commits: [{ hash: eventHash, subject: "Update research note" }]
    });
    expect(snapshot.commits).toHaveLength(1);
    expect(renamed).toMatchObject({
      repositoryPath: newPath,
      originalRepositoryPath: oldPath,
      vaultPath: newPath,
      originalVaultPath: oldPath,
      kind: "markdown",
      isAnchor: true,
      previewStatus: "ready"
    });
    expect(renamed?.beforeContent).toContain("[[旧目标]]");
    expect(renamed?.afterContent).toContain("[[新目标]]");
    expect(attachment).toMatchObject({
      status: "A",
      kind: "attachment",
      binary: true,
      previewStatus: "not-text"
    });
    expect(snapshot.relationDeltas).toEqual(expect.arrayContaining([
      expect.objectContaining({
        change: "removed",
        kind: "wikilink",
        target: "旧目标",
        sourceBeforePath: oldPath
      }),
      expect.objectContaining({
        change: "added",
        kind: "wikilink",
        target: "新目标",
        sourceAfterPath: newPath
      })
    ]));
  });

  it("infers one consecutive automatic-backup session without crossing a manual commit", async () => {
    const repository = createRepository();
    const notePath = "Notes/Session.md";
    writeText(repository, notePath, "# Session\n\nManual baseline.\n");
    const manualHash = commit(
      repository,
      "Curate research direction",
      "2026-07-29T10:00:00+09:00"
    );

    writeText(repository, notePath, "# Session\n\nManual baseline.\n\nPass one.\n");
    const firstBackupHash = commit(
      repository,
      "Vault Backup: pass one",
      "2026-07-29T10:15:00+09:00"
    );

    writeText(
      repository,
      notePath,
      "# Session\n\nManual baseline.\n\nPass one.\n\nPass two.\n"
    );
    const secondBackupHash = commit(
      repository,
      "Mac Backup: pass two",
      "2026-07-29T10:35:00+09:00"
    );

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: notePath,
      source: {
        kind: "commit",
        commitHash: secondBackupHash,
        aggregation: "session"
      }
    });

    expect(snapshot).toMatchObject({
      source: "git-session",
      confidence: "heuristic",
      aggregation: "session",
      baseHash: manualHash,
      headHash: secondBackupHash
    });
    expect(snapshot.commits.map((item) => item.hash)).toEqual([
      secondBackupHash,
      firstBackupHash
    ]);
    expect(snapshot.commits.some((item) => item.hash === manualHash)).toBe(false);
    expect(snapshot.netChanges).toEqual([
      expect.objectContaining({
        status: "M",
        vaultPath: notePath,
        beforeContent: "# Session\n\nManual baseline.\n",
        afterContent:
          "# Session\n\nManual baseline.\n\nPass one.\n\nPass two.\n"
      })
    ]);
    expect(snapshot.warnings[0]).toContain("编辑会话为推测结果");
  });

  it("counts each Vault-external file once across a session even when all are restored", async () => {
    const repository = createRepository();
    const vaultRoot = path.join(repository, "Vault");
    const notePath = "Notes/Session.md";
    const outsideTrackedPath = "Private/session-state.json";
    const outsideEphemeralPath = "Private/transient-cache.txt";
    writeText(vaultRoot, notePath, "# Session\n\nBaseline.\n");
    writeText(repository, outsideTrackedPath, "{\"phase\":\"baseline\"}\n");
    commit(
      repository,
      "Manual baseline",
      "2026-07-29T12:00:00+09:00"
    );

    writeText(vaultRoot, notePath, "# Session\n\nPass one.\n");
    writeText(repository, outsideTrackedPath, "{\"phase\":\"one\"}\n");
    writeText(repository, outsideEphemeralPath, "temporary one\n");
    commit(
      repository,
      "Vault Backup: pass one",
      "2026-07-29T12:10:00+09:00"
    );

    writeText(vaultRoot, notePath, "# Session\n\nPass two.\n");
    writeText(repository, outsideTrackedPath, "{\"phase\":\"two\"}\n");
    writeText(repository, outsideEphemeralPath, "temporary two\n");
    commit(
      repository,
      "Vault Backup: pass two",
      "2026-07-29T12:20:00+09:00"
    );

    writeText(vaultRoot, notePath, "# Session\n\nPass three.\n");
    writeText(repository, outsideTrackedPath, "{\"phase\":\"baseline\"}\n");
    rmSync(path.join(repository, outsideEphemeralPath));
    const restoredHash = commit(
      repository,
      "Vault Backup: restore external state",
      "2026-07-29T12:30:00+09:00"
    );

    const snapshot = await clientFor(vaultRoot).loadWorkEvent({
      anchorVaultPath: notePath,
      source: {
        kind: "commit",
        commitHash: restoredHash,
        aggregation: "session"
      }
    });

    expect(snapshot.source).toBe("git-session");
    expect(snapshot.commitSlices.map(
      (slice) => slice.hiddenRepositoryFileCount
    )).toEqual([2, 2, 2]);
    expect(snapshot.hiddenRepositoryFileCount).toBe(2);
    expect(snapshot.warnings).toContain(
      "另有 2 个 Vault 外仓库文件未展示。"
    );
    expect(snapshot.netChanges).toEqual([
      expect.objectContaining({
        vaultPath: notePath
      })
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("hiddenRepositoryFileIdentityGroups");
    expect(serialized).not.toContain(outsideTrackedPath);
    expect(serialized).not.toContain(outsideEphemeralPath);
    expect(serialized).not.toContain("session-state");
    expect(serialized).not.toContain("transient-cache");
  });

  it("captures tracked, untracked, deleted, and renamed working-tree files", async () => {
    const repository = createRepository();
    writeText(repository, "Notes/Tracked.md", "# Tracked\n\nBase.\n");
    writeText(repository, "Notes/Deleted.md", "# Deleted\n");
    writeText(repository, "Notes/Rename old.md", "# Rename\n\nStable content.\n");
    commit(repository, "Baseline");

    writeText(repository, "Notes/Tracked.md", "# Tracked\n\nWorking edit.\n");
    rmSync(path.join(repository, "Notes/Deleted.md"));
    git(repository, ["mv", "Notes/Rename old.md", "Notes/重命名 🧠.md"]);
    writeText(
      repository,
      "Notes/研究 🧠/未追踪 日本語.md",
      "# New\n\nUnicode path.\n"
    );

    const snapshot = await clientFor(repository).loadWorkEvent({
      anchorVaultPath: "Notes/Tracked.md",
      source: { kind: "working" }
    });
    const byPath = new Map(
      snapshot.netChanges.map((change) => [change.vaultPath, change])
    );

    expect(snapshot).toMatchObject({
      source: "working",
      confidence: "snapshot",
      aggregation: "working",
      commits: [],
      commitSlices: []
    });
    expect(byPath.get("Notes/Tracked.md")).toMatchObject({
      status: "M",
      isAnchor: true,
      previewStatus: "ready"
    });
    expect(byPath.get("Notes/Deleted.md")).toMatchObject({
      status: "D",
      afterContent: ""
    });
    expect(byPath.get("Notes/重命名 🧠.md")).toMatchObject({
      status: "R",
      originalVaultPath: "Notes/Rename old.md",
      previewStatus: "ready"
    });
    expect(byPath.get("Notes/研究 🧠/未追踪 日本語.md")).toMatchObject({
      status: "A",
      untracked: true,
      addedLines: 4,
      beforeContent: "",
      afterContent: "# New\n\nUnicode path.\n"
    });
  });

  it("keeps repository files outside a nested Vault hidden", async () => {
    const repository = createRepository();
    const vaultRoot = path.join(repository, "Vault");
    writeText(repository, "Vault/Notes/内部.md", "# 内部\n");
    writeText(repository, "repo-tool.txt", "outside the vault\n");
    const rootHash = commit(repository, "Create nested vault");

    const snapshot = await clientFor(vaultRoot).loadWorkEvent({
      anchorVaultPath: "Notes/内部.md",
      source: {
        kind: "commit",
        commitHash: rootHash,
        aggregation: "commit"
      }
    });

    expect(snapshot.baseHash).toBeUndefined();
    expect(snapshot.netChanges).toEqual([
      expect.objectContaining({
        status: "A",
        repositoryPath: "Vault/Notes/内部.md",
        vaultPath: "Notes/内部.md",
        isAnchor: true
      })
    ]);
    expect(snapshot.hiddenRepositoryFileCount).toBe(1);
    expect(snapshot.commitSlices[0]?.hiddenRepositoryFileCount).toBe(1);
    expect(snapshot.warnings).toContain("另有 1 个 Vault 外仓库文件未展示。");
    expect(
      snapshot.netChanges.some((change) =>
        change.vaultPath === ".." || change.vaultPath.startsWith("../")
      )
    ).toBe(false);
  });
});
