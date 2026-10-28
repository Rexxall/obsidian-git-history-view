import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { GitClient } from "../src/git/git-client";
import type { GitNoteHistorySettings } from "../src/models";
import {
  decodeGitNotesReview,
  encodeGitNotesReview
} from "../src/annotations/review-annotations";
import type { ReviewAnnotation } from "../src/annotations/types";

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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("review annotations in a dedicated Git notes ref", () => {
  it("writes review metadata without changing the commit or the working tree", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "git-review-notes-"));
    roots.push(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Review Test"]);
    git(root, ["config", "user.email", "review@example.com"]);
    writeFileSync(path.join(root, "Note.md"), "# Note\n");
    git(root, ["add", "Note.md"]);
    git(root, ["commit", "-q", "-m", "Initial"]);
    const hash = git(root, ["rev-parse", "HEAD"]).trim();
    const client = new GitClient({} as App, () => settings);
    expect(await client.readReviewGitNote(root, hash)).toBe("");
    git(root, ["notes", "--ref=git-note-history-review", "add", "-m", "Existing team note", hash]);
    const item: ReviewAnnotation = {
      id: "annotation-1",
      repositoryRoot: root,
      filePath: "Note.md",
      historicalPath: "Note.md",
      commitHash: hash,
      versionLabel: "Initial",
      target: "version",
      comment: "Check this version.",
      status: "pending",
      source: "local",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z"
    };
    const beforeStatus = git(root, ["status", "--porcelain=v1"]);
    const existing = await client.readReviewGitNote(root, hash);
    await client.writeReviewGitNote(root, hash, encodeGitNotesReview(existing, [item]));

    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(hash);
    expect(git(root, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    const stored = await client.readReviewGitNote(root, hash);
    expect(stored).toContain("Existing team note");
    expect(decodeGitNotesReview(stored)).toEqual([item]);
    expect(git(root, ["show-ref", "refs/notes/git-note-history-review"]).trim()).not.toBe("");
  });
});
