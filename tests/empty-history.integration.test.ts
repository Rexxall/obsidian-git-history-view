import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemAdapter } from "obsidian";
import type { App, TFile } from "obsidian";
import { GitClient, GitCommandError } from "../src/git/git-client";
import type { GitNoteHistorySettings } from "../src/models";

class TestAdapter extends FileSystemAdapter {
  constructor(private readonly root: string) {
    super();
  }
  getBasePath(): string {
    return this.root;
  }
}

const roots: string[] = [];
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
  showStatusBar: false,
};

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function file(root: string, vaultPath: string): TFile {
  const stats = statSync(path.join(root, vaultPath));
  return {
    path: vaultPath,
    extension: "md",
    basename: path.basename(vaultPath, ".md"),
    stat: {
      ctime: stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size
    }
  } as TFile;
}

function app(root: string): App {
  return {
    vault: {
      adapter: new TestAdapter(root),
      getFileByPath: (vaultPath: string) =>
        existsSync(path.join(root, vaultPath)) ? file(root, vaultPath) : null,
      read: async (target: TFile) =>
        readFileSync(path.join(root, target.path), "utf8")
    }
  } as unknown as App;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "git-empty-history-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Empty Test"]);
  git(root, ["config", "user.email", "empty@example.com"]);
  return root;
}

describe("why a note shows no versions", () => {
  it("tells no repository, no commits, untracked, ignored, staged and committed apart without changing Git", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "git-empty-plain-"));
    roots.push(plain);
    writeFileSync(path.join(plain, "Note.md"), "x\n");
    const notRepo = await new GitClient(app(plain), () => settings).loadFileHistory(file(plain, "Note.md")).catch((error: unknown) => error);
    expect(notRepo).toBeInstanceOf(GitCommandError);
    expect((notRepo as GitCommandError).problem).toBe("not-repo");

    const root = repo();
    writeFileSync(path.join(root, "Note.md"), "x\n");
    const client = new GitClient(app(root), () => settings);
    expect((await client.loadFileHistory(file(root, "Note.md"))).emptyReason).toBe("no-commits");

    writeFileSync(path.join(root, ".gitignore"), "Private.md\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "Ignore"]);
    expect((await client.loadFileHistory(file(root, "Note.md"))).emptyReason).toBe("untracked");

    writeFileSync(path.join(root, "Private.md"), "secret\n");
    const ignored = await client.loadFileHistory(file(root, "Private.md"));
    expect(ignored.emptyReason).toBe("ignored");
    expect(ignored.ignoreRule).toBe(".gitignore:1:Private.md");

    git(root, ["add", "Note.md"]);
    const before = git(root, ["status", "--porcelain=v1"]);
    expect((await client.loadFileHistory(file(root, "Note.md"))).emptyReason).toBe("staged");
    expect(git(root, ["status", "--porcelain=v1"])).toBe(before);

    git(root, ["commit", "-q", "-m", "Note"]);
    const committed = await client.loadFileHistory(file(root, "Note.md"));
    expect(committed.commits).toHaveLength(1);
    expect(committed.emptyReason).toBeUndefined();
  });
});
