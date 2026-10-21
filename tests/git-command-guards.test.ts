import { describe, expect, it, vi } from "vitest";
import type { GitNoteHistorySettings } from "../src/models";

const childProcessMock = vi.hoisted(() => ({
  options: null as null | { timeout?: number },
  killed: false
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _executable: string,
    _arguments: string[],
    options: { timeout?: number },
    callback: (error: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void
  ) => {
    childProcessMock.options = options;
    if (childProcessMock.killed) {
      const error: Error & { killed?: boolean } = new Error("Command failed");
      error.killed = true;
      callback(error, "", "");
    } else {
      callback(null, "content", "");
    }
    return { stdin: { end: vi.fn() } };
  }
}));

import {
  GIT_COMMAND_TIMEOUT_MS,
  GitClient,
  GitCommandError,
  normalizeMaxCommits
} from "../src/git/git-client";

const settings = { gitExecutable: "git" } as GitNoteHistorySettings;
const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("Git command guards", () => {
  it("passes a timeout to every Git read", async () => {
    childProcessMock.killed = false;
    const client = new GitClient({} as never, () => settings);
    await client.getFileContent("/repository", hash, "Note.md");
    expect(childProcessMock.options?.timeout).toBe(GIT_COMMAND_TIMEOUT_MS);
  });

  it("explains a timed-out Git command in plain words", async () => {
    childProcessMock.killed = true;
    const client = new GitClient({} as never, () => settings);
    const result = client.getFileContent("/repository", hash, "Note.md");
    await expect(result).rejects.toBeInstanceOf(GitCommandError);
    await expect(result).rejects.toThrow("秒未完成");
  });

  it("falls back to 100 when maxCommits is not a number", () => {
    expect(normalizeMaxCommits(Number.NaN)).toBe(100);
    expect(normalizeMaxCommits("abc")).toBe(100);
    expect(normalizeMaxCommits("250")).toBe(250);
    expect(normalizeMaxCommits(5000)).toBe(1000);
    expect(normalizeMaxCommits(0)).toBe(1);
  });
});
