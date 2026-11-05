import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** A repository with one committed note, plus a `git` wrapper that logs every call. */
function setup(): { root: string; log: string; client: GitClient; note: TFile } {
  const root = mkdtempSync(path.join(tmpdir(), "git-startup-calls-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Startup Test"]);
  git(root, ["config", "user.email", "startup@example.com"]);
  writeFileSync(path.join(root, "Note.md"), "One\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "Add note"]);

  const tools = mkdtempSync(path.join(tmpdir(), "git-startup-wrapper-"));
  roots.push(tools);
  const log = path.join(tools, "calls.log");
  writeFileSync(log, "");
  const wrapper = path.join(tools, "git-logged");
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec git "$@"\n`);
  chmodSync(wrapper, 0o755);

  const settings = {
    gitExecutable: wrapper,
    repositoryRoot: "",
    maxCommits: 100,
    showStatusBar: true
  } as GitNoteHistorySettings;
  const stats = statSync(path.join(root, "Note.md"));
  const note = {
    path: "Note.md",
    extension: "md",
    basename: "Note",
    stat: { ctime: stats.ctimeMs, mtime: stats.mtimeMs, size: stats.size }
  } as TFile;
  const app = {
    vault: {
      adapter: new TestAdapter(root),
      getFileByPath: () => note,
      read: async () => readFileSync(path.join(root, "Note.md"), "utf8")
    }
  } as unknown as App;
  return { root, log, client: new GitClient(app, () => settings), note };
}

function revParseCalls(log: string): number {
  return readFileSync(log, "utf8").split("\n").filter((line) => line.includes("rev-parse --show-toplevel")).length;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Git calls at startup", () => {
  it("finds the repository once when several checks start together", async () => {
    const { log, client, note } = setup();
    await Promise.all([
      client.loadNoteStatus(note),
      client.loadNoteStatus(note),
      client.resolveRepositoryContext()
    ]);
    expect(revParseCalls(log)).toBe(1);
  });

  it("looks again after a failed lookup instead of keeping the failure", async () => {
    const { root, log, client, note } = setup();
    rmSync(path.join(root, ".git"), { recursive: true, force: true });
    await expect(client.loadNoteStatus(note)).rejects.toThrow();
    git(root, ["init", "-q"]);
    await expect(client.resolveRepositoryContext()).resolves.toMatchObject({});
    expect(revParseCalls(log)).toBe(2);
  });
});
