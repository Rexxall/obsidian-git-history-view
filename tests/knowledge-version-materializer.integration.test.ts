import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
import { KnowledgeVersionMaterializer } from "../src/knowledge-trace/version-materializer";
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
  showStatusBar: false,
};

const repositories: string[] = [];

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

function createRepository(): string {
  const repository = mkdtempSync(
    path.join(tmpdir(), "git-note-knowledge-materializer-")
  );
  repositories.push(repository);
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "Knowledge Trace Test"]);
  git(repository, ["config", "user.email", "knowledge-trace@example.com"]);
  return repository;
}

function writeText(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function commit(
  repository: string,
  subject: string,
  committedAt?: string
): string {
  git(repository, ["add", "-A"]);
  const environment = committedAt
    ? {
        GIT_AUTHOR_DATE: committedAt,
        GIT_COMMITTER_DATE: committedAt
      }
    : {};
  git(repository, ["commit", "-q", "-m", subject], environment);
  return git(repository, ["rev-parse", "HEAD"]).trim();
}

function fakeApp(
  vaultRoot: string,
  afterRead?: (vaultPath: string, readCount: number, content: string) => void
): App {
  let readCount = 0;
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
        const content = readFileSync(path.join(vaultRoot, file.path), "utf8");
        readCount += 1;
        afterRead?.(file.path, readCount, content);
        return content;
      }
    }
  } as unknown as App;
}

function fileAt(vaultRoot: string, vaultPath: string): TFile {
  const fileStat = statSync(path.join(vaultRoot, vaultPath));
  return {
    path: vaultPath,
    stat: {
      ctime: fileStat.ctimeMs,
      mtime: fileStat.mtimeMs,
      size: fileStat.size
    }
  } as TFile;
}

function clientFor(
  vaultRoot: string,
  afterRead?: (vaultPath: string, readCount: number, content: string) => void
): GitClient {
  return new GitClient(fakeApp(vaultRoot, afterRead), () => settings);
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

function isRepositoryWideStatusCall(args: string[]): boolean {
  return args.includes("status") && !args.includes("--");
}

afterEach(() => {
  while (repositories.length > 0) {
    const repository = repositories.pop();
    if (repository) rmSync(repository, { recursive: true, force: true });
  }
});

describe("KnowledgeVersionMaterializer with real Git repositories", () => {
  it("keeps first-parent rename history in Git ancestry order and freezes working content", async () => {
    const repository = createRepository();
    writeText(
      repository,
      "Notes/Original.md",
      "shared line one\nshared line two\nshared line three\n"
    );
    const originalHash = commit(
      repository,
      "Original",
      "2026-07-30T12:00:00+09:00"
    );

    renameSync(
      path.join(repository, "Notes/Original.md"),
      path.join(repository, "Notes/Current.md")
    );
    writeText(
      repository,
      "Notes/Current.md",
      "shared line one\nshared line two\nshared line three\nrenamed\n"
    );
    const renameHash = commit(
      repository,
      "Rename",
      "2026-07-28T12:00:00+09:00"
    );
    const mainBranch = git(repository, ["branch", "--show-current"]).trim();

    git(repository, ["checkout", "-q", "-b", "side"]);
    writeText(repository, "Notes/Current.md", "from side branch\n");
    const sideHash = commit(
      repository,
      "Side change",
      "2026-07-31T12:00:00+09:00"
    );
    git(repository, ["checkout", "-q", mainBranch]);
    git(repository, ["merge", "-q", "--no-ff", "side", "-m", "Merge side"], {
      GIT_AUTHOR_DATE: "2026-07-29T12:00:00+09:00",
      GIT_COMMITTER_DATE: "2026-07-29T12:00:00+09:00"
    });
    const mergeHash = git(repository, ["rev-parse", "HEAD"]).trim();
    writeText(repository, "Notes/Current.md", "frozen working copy\n");

    const client = clientFor(repository);
    const calls = observeGitCalls(client);
    const materializer = new KnowledgeVersionMaterializer(client);
    const result = await materializer.materialize(
      fileAt(repository, "Notes/Current.md")
    );

    expect(result.samples.map((sample) => sample.commitHash ?? sample.kind)).toEqual([
      originalHash,
      renameHash,
      mergeHash,
      "working"
    ]);
    expect(
      result.samples
        .filter((sample) => sample.kind === "commit")
        .map((sample) => sample.commitHash)
    ).toEqual([originalHash, renameHash, mergeHash]);
    expect(result.samples.some((sample) => sample.commitHash === sideHash)).toBe(false);
    expect(result.samples.slice(0, 3).map((sample) => sample.historicalPath)).toEqual([
      "Notes/Original.md",
      "Notes/Current.md",
      "Notes/Current.md"
    ]);
    expect(result.samples[0]?.authoredAt).toBe("2026-07-30T12:00:00+09:00");
    expect(result.samples[1]?.authoredAt).toBe("2026-07-28T12:00:00+09:00");
    expect(result.workingSnapshot).toMatchObject({
      availability: "ready",
      content: "frozen working copy\n",
      staleAtCompletion: false
    });
    expect(result.workingSnapshot?.beforeFingerprint).toBe(
      result.workingSnapshot?.afterFingerprint
    );
    expect(result.samples.at(-1)?.fingerprint).toBe(
      result.workingSnapshot?.fingerprint
    );
    writeText(repository, "Notes/Current.md", "changed after capture\n");
    expect(
      await materializer.isWorkingSnapshotStale(
        fileAt(repository, "Notes/Current.md"),
        result.workingSnapshot!
      )
    ).toBe(true);
    expect(result.workingSnapshot?.content).toBe("frozen working copy\n");

    const commandNames = calls.map((args) =>
      args.find((argument) =>
        ["log", "show", "status", "rev-parse", "cat-file", "symbolic-ref"].includes(
          argument
        )
      )
    );
    expect(commandNames.every(Boolean)).toBe(true);
    expect(calls.some((args) =>
      args.some((argument) =>
        ["bisect", "checkout", "switch", "reset", "update-ref", "diff"].includes(argument)
      )
    )).toBe(false);
  });

  it("follows the old path of a staged working-tree rename", async () => {
    const repository = createRepository();
    const oldPath = "Notes/Before.md";
    const newPath = "Notes/After.md";
    writeText(repository, oldPath, "first\n");
    const firstHash = commit(repository, "First");
    writeText(repository, oldPath, "second\n");
    const secondHash = commit(repository, "Second");
    git(repository, ["mv", oldPath, newPath]);
    writeText(repository, newPath, "second\nworking edit after rename\n");

    const client = clientFor(repository);
    const calls = observeGitCalls(client);
    const result = await new KnowledgeVersionMaterializer(client).materialize(
      fileAt(repository, newPath)
    );

    expect(result.samples.map((sample) => sample.commitHash ?? sample.kind)).toEqual([
      firstHash,
      secondHash,
      "working"
    ]);
    expect(result.samples.slice(0, 2).map((sample) => sample.historicalPath)).toEqual([
      oldPath,
      oldPath
    ]);
    expect(result.workingSnapshot).toMatchObject({
      repositoryPath: newPath,
      content: "second\nworking edit after rename\n",
      availability: "ready"
    });
    expect(result.warnings).toContain(
      "已按 Git 暂存区确认的重命名，从旧路径连续读取历史。"
    );
    expect(calls.some((args) =>
      args.includes("log") && args.at(-1) === oldPath
    )).toBe(true);
    expect(calls.some(isRepositoryWideStatusCall)).toBe(false);
    expect(calls.some((args) =>
      args.includes("diff")
      && args.includes("--cached")
      && args.includes("--name-status")
    )).toBe(true);
  });

  it("follows one exact unstaged rename without staging or hashing into Git", async () => {
    const repository = createRepository();
    const oldPath = "Notes/Before.md";
    const newPath = "Notes/After.md";
    writeText(repository, oldPath, "same bytes\n");
    const firstHash = commit(repository, "First");
    writeText(repository, oldPath, "same bytes\nsecond version\n");
    const secondHash = commit(repository, "Second");
    renameSync(path.join(repository, oldPath), path.join(repository, newPath));
    for (let index = 0; index < 20; index += 1) {
      writeText(
        repository,
        `backup/session-${index}/snapshot.md`,
        `backup ${index}\n`
      );
    }

    const client = clientFor(repository);
    const calls = observeGitCalls(client);
    const result = await new KnowledgeVersionMaterializer(client).materialize(
      fileAt(repository, newPath)
    );

    expect(result.samples.map((sample) => sample.commitHash ?? sample.kind)).toEqual([
      firstHash,
      secondHash,
      "working"
    ]);
    expect(result.samples.slice(0, 2).map((sample) => sample.historicalPath)).toEqual([
      oldPath,
      oldPath
    ]);
    expect(result.workingSnapshot).toMatchObject({
      repositoryPath: newPath,
      content: "same bytes\nsecond version\n",
      staleAtCompletion: false
    });
    expect(result.warnings).toContain(
      "已通过与 HEAD 文件内容完全一致，确认未暂存重命名并从旧路径连续读取历史。"
    );
    const repositoryWideStatusCalls = calls.filter(isRepositoryWideStatusCall);
    expect(repositoryWideStatusCalls.length).toBeGreaterThan(0);
    expect(repositoryWideStatusCalls.every((args) =>
      args.includes("--untracked-files=no")
      && !args.includes("--untracked-files=all")
    )).toBe(true);
    expect(calls.some((args) =>
      args.some((argument) => ["hash-object", "diff", "bisect"].includes(argument))
    )).toBe(false);
  });

  it("does not guess an unstaged rename when two deleted notes have identical content", async () => {
    const repository = createRepository();
    const content = "identical\n";
    writeText(repository, "Notes/One.md", content);
    writeText(repository, "Notes/Two.md", content);
    commit(repository, "Two identical notes");
    rmSync(path.join(repository, "Notes/One.md"));
    rmSync(path.join(repository, "Notes/Two.md"));
    writeText(repository, "Notes/Current.md", content);

    const result = await new KnowledgeVersionMaterializer(
      clientFor(repository)
    ).materialize(fileAt(repository, "Notes/Current.md"));

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({
      kind: "working",
      availability: "ready",
      content
    });
    expect(result.warnings).toContain(
      "存在多个内容完全相同的旧路径候选，未猜测当前文件来自哪一篇笔记。"
    );
  });

  it("does not infer an unstaged rename after the moved content has changed", async () => {
    const repository = createRepository();
    writeText(repository, "Notes/Before.md", "original bytes\n");
    commit(repository, "Original");
    renameSync(
      path.join(repository, "Notes/Before.md"),
      path.join(repository, "Notes/After.md")
    );
    writeText(repository, "Notes/After.md", "changed after moving\n");

    const result = await new KnowledgeVersionMaterializer(
      clientFor(repository)
    ).materialize(fileAt(repository, "Notes/After.md"));

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({
      kind: "working",
      content: "changed after moving\n"
    });
    expect(result.warnings).not.toContain(
      "已通过与 HEAD 文件内容完全一致，确认未暂存重命名并从旧路径连续读取历史。"
    );
    expect(result.warnings).toContain(
      "检测到未暂存删除候选，但当前内容已变或无法唯一确认旧路径，未猜测重命名关系。"
    );
  });

  it("rejects exact rename inference when the tracked deletion set changes during history loading", async () => {
    const repository = createRepository();
    const oldPath = "Notes/Before.md";
    const newPath = "Notes/After.md";
    const content = "exact content\n";
    writeText(repository, oldPath, content);
    commit(repository, "Original");
    renameSync(path.join(repository, oldPath), path.join(repository, newPath));

    const client = clientFor(repository);
    const internal = client as unknown as InternalGitClient;
    const originalRunGit = internal.runGit.bind(client);
    let restored = false;
    internal.runGit = async (cwd, args, input) => {
      const output = await originalRunGit(cwd, args, input);
      if (!restored && args.includes("log") && args.at(-1) === oldPath) {
        restored = true;
        writeText(repository, oldPath, content);
      }
      return output;
    };

    await expect(
      new KnowledgeVersionMaterializer(client).materialize(
        fileAt(repository, newPath)
      )
    ).rejects.toThrow(
      "读取期间 Git HEAD、分支或当前笔记状态发生了变化，请重新发起追踪。"
    );
    expect(restored).toBe(true);
  });

  it("never scans repository-wide untracked status for an ordinary tracked note", async () => {
    const repository = createRepository();
    writeText(repository, "Note.md", "committed\n");
    commit(repository, "Committed");
    const client = clientFor(repository);
    const calls = observeGitCalls(client);
    const materializer = new KnowledgeVersionMaterializer(client);

    await materializer.materialize(fileAt(repository, "Note.md"));
    writeText(repository, "Note.md", "ordinary working edit\n");
    await materializer.materialize(fileAt(repository, "Note.md"));

    expect(calls.some(isRepositoryWideStatusCall)).toBe(false);
  });

  it("keeps a same-status working edit unavailable when content changes between reads", async () => {
    const repository = createRepository();
    writeText(repository, "Note.md", "baseline\n");
    commit(repository, "Baseline");
    writeText(repository, "Note.md", "working one\n");

    const client = clientFor(repository, (_vaultPath, readCount) => {
      if (readCount === 1) writeText(repository, "Note.md", "working two\n");
    });
    const result = await new KnowledgeVersionMaterializer(client).materialize(
      fileAt(repository, "Note.md")
    );
    const working = result.samples.at(-1);

    expect(working).toMatchObject({
      kind: "working",
      availability: "unavailable",
      unavailableCode: "concurrent-change"
    });
    expect(working?.content).toBeUndefined();
    expect(result.workingSnapshot).toMatchObject({
      availability: "unavailable",
      unavailableCode: "concurrent-change"
    });
  });

  it("does not read a working symlink whose physical target is outside the Vault", async () => {
    const repository = createRepository();
    const vaultRoot = path.join(repository, "Vault");
    mkdirSync(vaultRoot, { recursive: true });
    writeText(repository, "Outside.md", "private outside content\n");
    symlinkSync("../Outside.md", path.join(vaultRoot, "Linked.md"));
    commit(repository, "Track link");
    let workingReads = 0;

    const client = clientFor(vaultRoot, () => {
      workingReads += 1;
    });
    const result = await new KnowledgeVersionMaterializer(client).materialize(
      fileAt(vaultRoot, "Linked.md")
    );

    expect(workingReads).toBe(0);
    expect(result.samples.at(-1)).toMatchObject({
      kind: "working",
      availability: "unavailable",
      unavailableCode: "physical-boundary"
    });
    expect(result.workingSnapshot?.content).toBeUndefined();
  });

  it("keeps a rename source outside a nested Vault as unknown without reading its blob", async () => {
    const repository = createRepository();
    const vaultRoot = path.join(repository, "Vault");
    mkdirSync(vaultRoot, { recursive: true });
    writeText(
      repository,
      "Outside.md",
      "shared line one\nshared line two\nshared line three\n"
    );
    const outsideHash = commit(repository, "Outside source");
    renameSync(
      path.join(repository, "Outside.md"),
      path.join(vaultRoot, "Inside.md")
    );
    writeText(
      repository,
      "Vault/Inside.md",
      "shared line one\nshared line two\nshared line three\ninside Vault\n"
    );
    const insideHash = commit(repository, "Move into Vault");

    const client = clientFor(vaultRoot);
    const calls = observeGitCalls(client);
    const result = await new KnowledgeVersionMaterializer(client).materialize(
      fileAt(vaultRoot, "Inside.md")
    );

    expect(result.samples[0]).toMatchObject({
      commitHash: outsideHash,
      historicalPath: "Outside.md",
      availability: "unavailable",
      unavailableCode: "physical-boundary"
    });
    expect(result.samples[1]).toMatchObject({
      commitHash: insideHash,
      historicalPath: "Vault/Inside.md",
      availability: "ready"
    });
    expect(result.warnings).toContain("部分历史路径位于 Vault 之外，未读取其正文。");
    expect(calls.some((args) =>
      ["cat-file", "show"].includes(args[0] ?? "")
      && args.some((argument) => argument.includes("Outside.md"))
    )).toBe(false);
  });

  it("retains oversized and total-limit versions as explicit unavailable samples", async () => {
    const repository = createRepository();
    writeText(repository, "Note.md", "a\n");
    commit(repository, "Small one");
    writeText(repository, "Note.md", "bbbb\n");
    commit(repository, "Small two");
    writeText(repository, "Note.md", `${"x".repeat(40)}\n`);
    commit(repository, "Large");
    writeText(repository, "Note.md", "work");

    const client = clientFor(repository);
    const calls = observeGitCalls(client);
    const originalInspect = client.inspectHistoricalFileObject.bind(client);
    let activeInspections = 0;
    let maxActiveInspections = 0;
    client.inspectHistoricalFileObject = async (...args) => {
      activeInspections += 1;
      maxActiveInspections = Math.max(maxActiveInspections, activeInspections);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await originalInspect(...args);
      } finally {
        activeInspections -= 1;
      }
    };
    const result = await new KnowledgeVersionMaterializer(client).materialize(
      fileAt(repository, "Note.md"),
      {
      maxVersions: 4,
      maxFileBytes: 16,
      maxTotalBytes: 9,
      maxConcurrency: 2
      }
    );

    expect(result.samples).toHaveLength(4);
    expect(result.samples[0]).toMatchObject({
      availability: "unavailable",
      unavailableCode: "total-limit"
    });
    expect(result.samples[1]).toMatchObject({
      availability: "ready",
      content: "bbbb\n"
    });
    expect(result.samples[2]).toMatchObject({
      availability: "unavailable",
      unavailableCode: "too-large"
    });
    expect(result.samples[3]).toMatchObject({
      kind: "working",
      availability: "ready",
      content: "work"
    });
    expect(result.materializedBytes).toBe(9);
    expect(maxActiveInspections).toBe(2);
    const totalLimitedHash = result.samples[0]?.commitHash;
    expect(calls.some((args) =>
      args[0] === "show"
      && args[1] === `${totalLimitedHash}:Note.md`
    )).toBe(false);
  });

  it("caps the retained history window without reordering its Git sequence", async () => {
    const repository = createRepository();
    const hashes: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      writeText(repository, "Note.md", `version ${index}\n`);
      hashes.push(commit(repository, `Version ${index}`));
    }

    const result = await new KnowledgeVersionMaterializer(
      clientFor(repository)
    ).materialize(fileAt(repository, "Note.md"), { maxVersions: 3 });

    expect(result.samples).toHaveLength(3);
    expect(result.hasMoreHistory).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.samples.slice(0, 2).map((sample) => sample.commitHash)).toEqual(
      hashes.slice(3)
    );
    expect(result.samples.at(-1)?.kind).toBe("working");
  });
});
