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
import { buildProvenanceLensAnalysis } from "../src/provenance/provenance-lens";

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

function git(repository: string, args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8"
  });
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "git-note-provenance-"));
  repositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Human Reviewer"]);
  git(root, ["config", "user.email", "human@example.com"]);
  return root;
}

function file(root: string, vaultPath: string): TFile {
  const value = statSync(path.join(root, vaultPath));
  return {
    path: vaultPath,
    extension: "md",
    basename: path.basename(vaultPath, ".md"),
    stat: {
      ctime: value.ctimeMs,
      mtime: value.mtimeMs,
      size: value.size
    }
  } as TFile;
}

function app(root: string): App {
  return {
    vault: {
      adapter: new TestFileSystemAdapter(root),
      getFileByPath: (vaultPath: string) => {
        const absolute = path.join(root, vaultPath);
        return existsSync(absolute) ? file(root, vaultPath) : null;
      },
      read: async (target: TFile) =>
        readFileSync(path.join(root, target.path), "utf8")
    }
  } as unknown as App;
}

afterEach(() => {
  for (const root of repositories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("GitClient provenance lens with a real Git repository", () => {
  it("attributes committed Agent lines and uncommitted lines without changing Git", async () => {
    const root = repository();
    writeFileSync(
      path.join(root, "Note.md"),
      "# Result\n\nHuman statement [[Paper]].\n"
    );
    git(root, ["add", "Note.md"]);
    git(root, ["commit", "-q", "-m", "Human draft"]);

    writeFileSync(
      path.join(root, "Note.md"),
      "# Result\n\nHuman statement [[Paper]].\n\nAgent statement [[Paper]].\n"
    );
    git(root, ["add", "Note.md"]);
    git(root, [
      "commit",
      "-q",
      "-m",
      "Agent edit",
      "-m",
      "Agent: research-agent\nAuthority: draft\nSend-Gate: user_review_not_sent\nWorkflow-Status: review"
    ]);
    const agentHash = git(root, ["rev-parse", "HEAD"]).trim();

    writeFileSync(
      path.join(root, "Note.md"),
      "# Result\n\nHuman statement [[Paper]].\n\nAgent statement [[Paper]].\n\nWorking statement.\n"
    );
    const beforeHead = git(root, ["rev-parse", "HEAD"]).trim();
    const beforeStatus = git(root, ["status", "--porcelain=v1"]);
    const client = new GitClient(app(root), () => settings);
    const snapshot = await client.loadProvenanceLens(file(root, "Note.md"));
    const analysis = buildProvenanceLensAnalysis({
      content: snapshot.content,
      ...(snapshot.previousContent !== undefined
        ? { previousContent: snapshot.previousContent }
        : {}),
      blame: snapshot.blame,
      commits: snapshot.commits,
      reviewState: { bookmarks: {}, milestones: {} }
    });

    expect(snapshot.blame.some((line) => line.hash === agentHash)).toBe(true);
    expect(snapshot.blame.some((line) => line.working)).toBe(true);
    expect(analysis.blocks.some((block) =>
      block.sources.some((source) =>
        source.kind === "agent"
        && source.label === "research-agent"
        && source.trailers["send-gate"] === "user_review_not_sent"
      )
    )).toBe(true);
    expect(analysis.summary.workingBlocks).toBe(1);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(beforeHead);
    expect(git(root, ["status", "--porcelain=v1"])).toBe(beforeStatus);
  });

  it("keeps every line of an untracked note explicitly in the working source", async () => {
    const root = repository();
    writeFileSync(path.join(root, "Seed.md"), "# Seed\n");
    git(root, ["add", "Seed.md"]);
    git(root, ["commit", "-q", "-m", "Seed"]);
    writeFileSync(path.join(root, "New.md"), "# New\n\nUntracked content.\n");

    const client = new GitClient(app(root), () => settings);
    const snapshot = await client.loadProvenanceLens(file(root, "New.md"));
    expect(snapshot.blame).toHaveLength(4);
    expect(snapshot.blame.every((line) => line.working)).toBe(true);
    expect(snapshot.commits).toHaveLength(0);
  });
});
