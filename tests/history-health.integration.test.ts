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
import { GitClient } from "../src/git/git-client";
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
  useBlameIgnoreRevs: true
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

describe("GitClient history health with a real repository", () => {
  it("reports upstream distance and ignore-revs without modifying Git state", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "git-history-health-"));
    const remote = mkdtempSync(path.join(tmpdir(), "git-history-health-remote-"));
    roots.push(root, remote);
    git(root, ["init", "-q"]);
    git(remote, ["init", "--bare", "-q"]);
    git(root, ["config", "user.name", "Health Test"]);
    git(root, ["config", "user.email", "health@example.com"]);
    writeFileSync(path.join(root, "Note.md"), "# Note\n\nFirst\n");
    git(root, ["add", "Note.md"]);
    git(root, ["commit", "-q", "-m", "First"]);
    const ignoredHash = git(root, ["rev-parse", "HEAD"]).trim();
    writeFileSync(path.join(root, ".git-blame-ignore-revs"), `${ignoredHash}\n`);
    git(root, ["add", ".git-blame-ignore-revs"]);
    git(root, ["commit", "-q", "-m", "Add ignore revs"]);
    const branch = git(root, ["branch", "--show-current"]).trim();
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["push", "-q", "-u", "origin", branch]);
    writeFileSync(path.join(root, "Note.md"), "# Note\n\nSecond\n");
    git(root, ["add", "Note.md"]);
    git(root, ["commit", "-q", "-m", "Local note edit"]);

    const beforeHead = git(root, ["rev-parse", "HEAD"]).trim();
    const beforeStatus = git(root, ["status", "--porcelain=v1"]);
    const client = new GitClient(app(root), () => settings);
    const health = await client.loadHistoryHealth(file(root, "Note.md"));

    expect(health.shallow).toBe(false);
    expect(health.partialClone).toBe(false);
    expect(health.upstream).toBe(`origin/${branch}`);
    expect(health.ahead).toBe(1);
    expect(health.behind).toBe(0);
    expect(health.ignoreRevs).toContain(ignoredHash);
    expect(health.missingObjects).toEqual([]);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(beforeHead);
    expect(git(root, ["status", "--porcelain=v1"])).toBe(beforeStatus);
  });
});
