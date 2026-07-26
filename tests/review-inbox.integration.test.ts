import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSystemAdapter } from "obsidian";
import type { App, TFile } from "obsidian";
import { GitClient } from "../src/git/git-client";
import type { GitNoteHistorySettings } from "../src/models";
import { groupReviewInboxItems } from "../src/review/review-inbox";

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
  reviewExcludedPaths: ["backup", "backups", ".trash", ".obsidian", "node_modules"]
};

describe("review inbox with a real temporary Git vault", () => {
  let repository = "";
  let client: GitClient;

  const git = (args: string[]): string =>
    execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });

  const write = (relativePath: string, content: string): void => {
    const absolutePath = path.join(repository, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  };

  const fakeApp = (): App => ({
    vault: {
      adapter: new TestFileSystemAdapter(repository),
      getFileByPath: (vaultPath: string) => {
        const absolutePath = path.join(repository, vaultPath);
        return existsSync(absolutePath) ? { path: vaultPath } as TFile : null;
      },
      read: async (file: TFile) =>
        readFileSync(path.join(repository, file.path), "utf8")
    }
  } as unknown as App);

  beforeEach(() => {
    repository = mkdtempSync(path.join(tmpdir(), "git-note-review-inbox-"));
    git(["init", "-q"]);
    git(["config", "user.name", "Review Inbox Test"]);
    git(["config", "user.email", "review@example.com"]);
    client = new GitClient(fakeApp(), () => settings);
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
  });

  it("merges committed and working changes once and excludes backup/config paths", async () => {
    write("Notes/Shared.md", "# Shared\n\nBase.\n");
    write("Notes/Committed.md", "# Committed\n\nBase.\n");
    write("backup/ignored.md", "# Backup\n\nBase.\n");
    write(".obsidian/plugin-state.md", "# Config\n\nBase.\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "Baseline"]);
    const baseline = git(["rev-parse", "HEAD"]).trim();

    write("Notes/Shared.md", "# Shared\n\nCommitted change.\n");
    write("Notes/Committed.md", "# Committed\n\nCommitted change.\n");
    write("Notes/New committed.md", "# New\n\nCommitted note.\n");
    write("backup/ignored.md", "# Backup\n\nCommitted backup change.\n");
    write(".obsidian/plugin-state.md", "# Config\n\nCommitted config change.\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "Update reviewed notes"]);

    write("Notes/Shared.md", "# Shared\n\nCommitted change.\n\nWorking change.\n");
    write("Notes/Working.md", "# Working\n\nUncommitted note.\n");
    write("backup/working.md", "# Backup\n\nUncommitted backup.\n");
    write(".obsidian/working.md", "# Config\n\nUncommitted config.\n");

    const snapshot = await client.loadReviewInbox(baseline, settings.reviewExcludedPaths);
    const byPath = new Map(snapshot.items.map((item) => [item.path, item]));

    expect(snapshot.baselineValid).toBe(true);
    expect(snapshot.headHash).toBe(git(["rev-parse", "HEAD"]).trim());
    expect([...byPath.keys()].sort()).toEqual([
      "Notes/Committed.md",
      "Notes/New committed.md",
      "Notes/Shared.md",
      "Notes/Working.md"
    ]);
    expect(byPath.get("Notes/Shared.md")).toMatchObject({
      committedChange: { changeType: "M" },
      workspaceChange: { workTreeStatus: "M" },
      latestCommit: { subject: "Update reviewed notes" }
    });
    expect(byPath.get("Notes/Committed.md")?.workspaceChange).toBeUndefined();
    expect(byPath.get("Notes/Working.md")?.committedChange).toBeUndefined();
    expect(byPath.get("Notes/Working.md")?.workspaceChange).toMatchObject({
      untracked: true
    });
    expect(snapshot.items.some((item) => item.path.startsWith("backup/"))).toBe(false);
    expect(snapshot.items.some((item) => item.path.startsWith(".obsidian/"))).toBe(false);
  });

  it("keeps working changes visible when a saved baseline is no longer valid", async () => {
    write("Notes/Tracked.md", "# Tracked\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "Baseline"]);
    write("Notes/Tracked.md", "# Tracked\n\nWorking change.\n");

    const snapshot = await client.loadReviewInbox("deadbeef", settings.reviewExcludedPaths);

    expect(snapshot.baselineValid).toBe(false);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      path: "Notes/Tracked.md",
      workspaceChange: { workTreeStatus: "M" }
    });
    expect(snapshot.items[0]?.committedChange).toBeUndefined();
  });

  it("puts a real merge conflict ahead of ordinary pending changes", async () => {
    write("Notes/Conflict.md", "# Conflict\n\nBase.\n");
    write("Notes/Working.md", "# Working\n\nBase.\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "Baseline"]);
    const baseline = git(["rev-parse", "HEAD"]).trim();
    const mainBranch = git(["branch", "--show-current"]).trim();

    git(["checkout", "-q", "-b", "incoming"]);
    write("Notes/Conflict.md", "# Conflict\n\nIncoming.\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "Incoming change"]);

    git(["checkout", "-q", mainBranch]);
    write("Notes/Conflict.md", "# Conflict\n\nLocal.\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "Local change"]);
    expect(() => git(["merge", "incoming"])).toThrow();
    write("Notes/Working.md", "# Working\n\nOrdinary working change.\n");

    const snapshot = await client.loadReviewInbox(baseline, settings.reviewExcludedPaths);
    const conflict = snapshot.items.find((item) => item.path === "Notes/Conflict.md");
    const groups = groupReviewInboxItems(snapshot.items);

    expect(conflict).toMatchObject({
      committedChange: { changeType: "M" },
      workspaceChange: { conflicted: true }
    });
    expect(groups[0]).toMatchObject({
      key: "attention",
      items: [expect.objectContaining({ path: "Notes/Conflict.md" })]
    });
    expect(groups.some((group) =>
      group.key === "working" && group.items.some((item) => item.path === "Notes/Working.md")
    )).toBe(true);
  });
});
