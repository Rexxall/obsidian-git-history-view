import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseGitLog, parseNumStatLog, parseWorkspaceStatus } from "../src/git/parse-log";

const LOG_FORMAT = "%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B%x1d";
const repository = mkdtempSync(path.join(tmpdir(), "git-note-history-test-"));
const conflictRepository = mkdtempSync(path.join(tmpdir(), "git-note-conflict-test-"));

function git(args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
}

afterAll(() => {
  rmSync(repository, { recursive: true, force: true });
  rmSync(conflictRepository, { recursive: true, force: true });
});

describe("real Git conflict stages", () => {
  it("exposes ancestor, ours, and theirs blobs for a conflicted Markdown file", () => {
    const conflictGit = (args: string[]): string =>
      execFileSync("git", ["-C", conflictRepository, ...args], { encoding: "utf8" });
    conflictGit(["init", "-q"]);
    conflictGit(["config", "user.name", "Conflict Test"]);
    conflictGit(["config", "user.email", "conflict@example.com"]);
    writeFileSync(path.join(conflictRepository, "note.md"), "base\n");
    conflictGit(["add", "note.md"]);
    conflictGit(["commit", "-q", "-m", "Base"]);
    const mainBranch = conflictGit(["branch", "--show-current"]).trim();
    conflictGit(["checkout", "-q", "-b", "remote"]);
    writeFileSync(path.join(conflictRepository, "note.md"), "remote\n");
    conflictGit(["commit", "-qam", "Remote edit"]);
    conflictGit(["checkout", "-q", mainBranch]);
    writeFileSync(path.join(conflictRepository, "note.md"), "local\n");
    conflictGit(["commit", "-qam", "Local edit"]);
    try {
      conflictGit(["merge", "remote"]);
    } catch {
      // A non-zero merge exit is the expected fixture state.
    }

    expect(conflictGit(["ls-files", "-u", "--", "note.md"]).trim()).not.toBe("");
    expect(conflictGit(["show", ":1:note.md"])).toBe("base\n");
    expect(conflictGit(["show", ":2:note.md"])).toBe("local\n");
    expect(conflictGit(["show", ":3:note.md"])).toBe("remote\n");
  });
});

describe("real Git history", () => {
  it("follows a renamed note and reads every version", () => {
    git(["init", "-q"]);
    git(["config", "user.name", "History Test"]);
    git(["config", "user.email", "history@example.com"]);
    mkdirSync(path.join(repository, "Notes"));

    writeFileSync(path.join(repository, "Notes", "old.md"), "version one\n");
    git(["add", "Notes/old.md"]);
    git(["commit", "-q", "-m", "Create old note"]);

    git(["mv", "Notes/old.md", "Notes/new.md"]);
    git(["commit", "-q", "-m", "Rename note"]);

    writeFileSync(path.join(repository, "Notes", "new.md"), "version three\n");
    git(["add", "Notes/new.md"]);
    git(["commit", "-q", "-m", "Edit new note", "-m", "Agent: local-tool\nAuthority: working_master"]);

    const raw = git([
      "-c",
      "core.quotePath=false",
      "log",
      "--follow",
      "--find-renames",
      `--format=${LOG_FORMAT}`,
      "--name-status",
      "--",
      "Notes/new.md"
    ]);
    const commits = parseGitLog(raw, "Notes/new.md");

    expect(commits).toHaveLength(3);
    expect(commits[0]?.trailers).toMatchObject({ agent: "local-tool", authority: "working_master" });
    expect(commits.map((commit) => commit.historicalPath)).toEqual([
      "Notes/new.md",
      "Notes/new.md",
      "Notes/old.md"
    ]);

    const contents = commits.map((commit) =>
      git(["show", `${commit.hash}:${commit.historicalPath}`])
    );
    expect(contents).toEqual(["version three\n", "version one\n", "version one\n"]);

    const stats = parseNumStatLog(git([
      "log",
      "--follow",
      "--format=%x1e%H",
      "--numstat",
      "--",
      "Notes/new.md"
    ]));
    expect(stats.get(commits[0]!.hash)).toMatchObject({ addedLines: 1, deletedLines: 1 });

    const lineHistory = parseGitLog(git([
      "log",
      `--format=${LOG_FORMAT}`,
      "--no-patch",
      "-L",
      "1,1:Notes/new.md"
    ]), "Notes/new.md");
    expect(lineHistory.length).toBeGreaterThanOrEqual(2);

    writeFileSync(path.join(repository, "Notes", "new.md"), "working tree\n");
    writeFileSync(path.join(repository, "Notes", "untracked.md"), "new note\n");
    const workspace = parseWorkspaceStatus(git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all"
    ]));
    expect(workspace).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "Notes/new.md", workTreeStatus: "M" }),
      expect.objectContaining({ path: "Notes/untracked.md", untracked: true })
    ]));
  });
});
