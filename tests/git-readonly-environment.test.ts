import { describe, expect, it, vi } from "vitest";
import type { GitNoteHistorySettings } from "../src/models";

const childProcessMock = vi.hoisted(() => ({
  options: null as null | { env?: NodeJS.ProcessEnv }
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _executable: string,
    _arguments: string[],
    options: { env?: NodeJS.ProcessEnv },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    childProcessMock.options = options;
    callback(null, "content", "");
    return {
      stdin: {
        end: vi.fn()
      }
    };
  }
}));

import { GitClient } from "../src/git/git-client";

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

describe("GitClient read-only environment", () => {
  it("disables optional locks and lazy object fetching for Git reads", async () => {
    const client = new GitClient({} as never, () => settings);

    await client.getFileContent(
      "/repository",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Note.md"
    );

    expect(childProcessMock.options?.env).toMatchObject({
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_PAGER: "cat"
    });
  });
});
