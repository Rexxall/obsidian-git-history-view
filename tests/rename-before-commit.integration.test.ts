import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  useBlameIgnoreRevs: true,
  showLabTools: false,
  showStatusBar: false,
};

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function write(root: string, vaultPath: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, vaultPath)), { recursive: true });
  writeFileSync(path.join(root, vaultPath), content);
}

function file(root: string, vaultPath: string): TFile {
  const stats = statSync(path.join(root, vaultPath));
  return {
    path: vaultPath,
    extension: "md",
    basename: path.basename(vaultPath, ".md"),
    stat: { ctime: stats.ctimeMs, mtime: stats.mtimeMs, size: stats.size }
  } as TFile;
}

function app(root: string): App {
  return {
    vault: {
      adapter: new TestAdapter(root),
      getFileByPath: (vaultPath: string) => (existsSync(path.join(root, vaultPath)) ? file(root, vaultPath) : null),
      read: async (target: TFile) => readFileSync(path.join(root, target.path), "utf8")
    }
  } as unknown as App;
}

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "git-rename-before-commit-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Rename Test"]);
  git(root, ["config", "user.email", "rename@example.com"]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a note moved or renamed before the rename is committed", () => {
  it("shows the old path's history for an unstaged move with identical content", async () => {
    const root = repo();
    write(root, "99 - ToDo/Untitled.md", "chain of ideas\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "First"]);
    write(root, "99 - ToDo/Untitled.md", "chain of ideas\nsecond version\n");
    git(root, ["commit", "-q", "-am", "Second"]);
    const newPath = "10 - Projects/CV/research-chain-2026-06.md";
    mkdirSync(path.dirname(path.join(root, newPath)), { recursive: true });
    renameSync(path.join(root, "99 - ToDo/Untitled.md"), path.join(root, newPath));

    const before = git(root, ["status", "--porcelain=v1"]);
    const history = await new GitClient(app(root), () => settings).loadFileHistory(file(root, newPath));

    expect(history.status.untracked).toBe(true);
    expect(history.emptyReason).toBeUndefined();
    expect(history.commits.map((commit) => commit.subject)).toEqual(["Second", "First"]);
    expect(history.commits.every((commit) => commit.historicalPath === "99 - ToDo/Untitled.md")).toBe(true);
    expect(history.workingTreeStats).toEqual({ addedLines: 0, deletedLines: 0 });
    expect(history.workingRename).toEqual({
      kind: "exact-unstaged",
      currentPath: newPath,
      originalPath: "99 - ToDo/Untitled.md"
    });
    expect(git(root, ["status", "--porcelain=v1"])).toBe(before);
  });

  it("follows a staged rename (git mv) the same way", async () => {
    const root = repo();
    write(root, "Old.md", "same\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "First"]);
    git(root, ["mv", "Old.md", "New.md"]);

    const history = await new GitClient(app(root), () => settings).loadFileHistory(file(root, "New.md"));

    expect(history.commits.map((commit) => commit.subject)).toEqual(["First"]);
    expect(history.workingRename?.kind).toBe("staged");
    expect(history.workingRename?.originalPath).toBe("Old.md");
  });

  it("gives the status bar and compare command the old path's last commit", async () => {
    const root = repo();
    write(root, "Old.md", "same\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "First"]);
    mkdirSync(path.join(root, "Moved"), { recursive: true });
    renameSync(path.join(root, "Old.md"), path.join(root, "Moved/New.md"));

    const note = await new GitClient(app(root), () => settings).loadNoteStatus(file(root, "Moved/New.md"));

    expect(note.lastCommit?.subject).toBe("First");
    expect(note.lastCommit?.historicalPath).toBe("Old.md");
    expect(note.workingRename?.originalPath).toBe("Old.md");
  });

  it("leaves a brand-new note without a last commit", async () => {
    const root = repo();
    write(root, "Old.md", "same\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "First"]);
    write(root, "Fresh.md", "a new note\n");

    const note = await new GitClient(app(root), () => settings).loadNoteStatus(file(root, "Fresh.md"));

    expect(note.lastCommit).toBeNull();
    expect(note.workingRename).toBeUndefined();
  });

  it("matches a moved note that was edited afterwards by content, and says so", async () => {
    const root = repo();
    const body = Array.from({ length: 12 }, (_, index) => `Point ${index + 1} in the research chain.`).join("\n") + "\n";
    write(root, "99 - ToDo/Untitled.md", body);
    write(root, "Other.md", "an unrelated note\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "First"]);
    const newPath = "10 - Projects/research-chain.md";
    mkdirSync(path.join(root, "10 - Projects"), { recursive: true });
    renameSync(path.join(root, "99 - ToDo/Untitled.md"), path.join(root, newPath));
    write(root, newPath, body.replace("Point 2 in the research chain.", "Point 2, edited after the move.") + "One more point.\n");

    const before = git(root, ["status", "--porcelain=v1"]);
    const client = new GitClient(app(root), () => settings);
    const history = await client.loadFileHistory(file(root, newPath));
    const note = await client.loadNoteStatus(file(root, newPath));

    expect(history.commits.map((commit) => commit.subject)).toEqual(["First"]);
    expect(history.workingRename?.kind).toBe("similar-unstaged");
    expect(history.workingRename?.originalPath).toBe("99 - ToDo/Untitled.md");
    expect(history.workingRename?.similarity).toBeGreaterThan(0.8);
    expect(history.workingTreeStats).toEqual({ addedLines: 2, deletedLines: 1 });
    expect(note.lastCommit?.historicalPath).toBe("99 - ToDo/Untitled.md");
    expect(git(root, ["status", "--porcelain=v1"])).toBe(before);
  });

  it("does not guess between two moved notes made from the same template", async () => {
    const root = repo();
    const template = "## Meeting\n\n- Date:\n- People:\n- Notes:\n- Next steps:\n";
    write(root, "A.md", `${template}- A\n`);
    write(root, "B.md", `${template}- B\n`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "First"]);
    rmSync(path.join(root, "A.md"));
    rmSync(path.join(root, "B.md"));
    write(root, "Moved/Meeting.md", `${template}- edited\n`);

    const history = await new GitClient(app(root), () => settings).loadFileHistory(file(root, "Moved/Meeting.md"));

    expect(history.commits).toEqual([]);
    expect(history.workingRename).toBeUndefined();
  });

  it("still reports an untracked note when the moved content was edited", async () => {
    const root = repo();
    write(root, "Old.md", "same\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "First"]);
    renameSync(path.join(root, "Old.md"), path.join(root, "New.md"));
    write(root, "New.md", "same\nchanged after the move\n");

    const history = await new GitClient(app(root), () => settings).loadFileHistory(file(root, "New.md"));

    expect(history.commits).toEqual([]);
    expect(history.emptyReason).toBe("untracked");
    expect(history.workingRename).toBeUndefined();
  });
});
