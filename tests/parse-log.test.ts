import { describe, expect, it } from "vitest";
import {
  parseGitLog,
  parseGitStatus,
  parseNumStatLog,
  parseWorkspaceStatus
} from "../src/git/parse-log";

const RS = "\u001e";
const FS = "\u001f";
const BS = "\u001d";

describe("parseGitLog", () => {
  it("parses commits newest first", () => {
    const raw =
      `${RS}aaaaaaaa${FS}aaaaaaa${FS}Alice${FS}alice@example.com${FS}2026-07-15T12:00:00+09:00${FS}Update note\nM\tNotes/current.md\n` +
      `${RS}bbbbbbbb${FS}bbbbbbb${FS}Bob${FS}bob@example.com${FS}2026-07-14T10:00:00+09:00${FS}Create note\nA\tNotes/current.md\n`;

    const commits = parseGitLog(raw, "Notes/current.md");

    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      shortHash: "aaaaaaa",
      subject: "Update note",
      historicalPath: "Notes/current.md",
      changeType: "M"
    });
  });

  it("tracks the historical path across a rename", () => {
    const raw =
      `${RS}aaaaaaaa${FS}aaaaaaa${FS}Alice${FS}alice@example.com${FS}2026-07-15T12:00:00+09:00${FS}Edit renamed note\nM\tNotes/new.md\n` +
      `${RS}bbbbbbbb${FS}bbbbbbb${FS}Alice${FS}alice@example.com${FS}2026-07-14T12:00:00+09:00${FS}Rename note\nR100\tNotes/old.md\tNotes/new.md\n` +
      `${RS}cccccccc${FS}ccccccc${FS}Alice${FS}alice@example.com${FS}2026-07-13T12:00:00+09:00${FS}Original note\nA\tNotes/old.md\n`;

    const commits = parseGitLog(raw, "Notes/new.md");

    expect(commits.map((commit) => commit.historicalPath)).toEqual([
      "Notes/new.md",
      "Notes/new.md",
      "Notes/old.md"
    ]);
  });

  it("extracts supported commit trailers", () => {
    const raw = `${RS}aaaaaaaa${FS}aaaaaaa${FS}Local Tool${FS}local-tool@example.com${FS}2026-07-15T12:00:00+09:00${FS}Review note${FS}Review note\n\nAgent: local-tool\nAuthority: working_master\nSend-Gate: user_review_not_sent${BS}\nM\tNotes/current.md\n`;
    expect(parseGitLog(raw, "Notes/current.md")[0]?.trailers).toEqual({
      agent: "local-tool",
      authority: "working_master",
      "send-gate": "user_review_not_sent"
    });
  });
});

describe("parseGitStatus", () => {
  it("detects staged and unstaged changes", () => {
    expect(parseGitStatus("M  Notes/a.md\n")).toMatchObject({ staged: true, unstaged: false });
    expect(parseGitStatus(" M Notes/a.md\n")).toMatchObject({ staged: false, unstaged: true });
    expect(parseGitStatus("MM Notes/a.md\n")).toMatchObject({ staged: true, unstaged: true });
  });

  it("detects untracked and conflicted files", () => {
    expect(parseGitStatus("?? Notes/a.md\n")).toMatchObject({ untracked: true, unstaged: true });
    expect(parseGitStatus("UU Notes/a.md\n")).toMatchObject({ conflicted: true });
  });
});

describe("Git statistics", () => {
  it("parses per-commit numstat output", () => {
    const stats = parseNumStatLog(`${RS}abc123\n10\t2\tNotes/a.md\n${RS}def456\n3\t4\tNotes/a.md\n`);
    expect(stats.get("abc123")).toMatchObject({ addedLines: 10, deletedLines: 2 });
    expect(stats.get("def456")).toMatchObject({ addedLines: 3, deletedLines: 4 });
  });

  it("parses zero-delimited workspace status including rename", () => {
    const changes = parseWorkspaceStatus(" M Notes/a.md\0R  Notes/new.md\0Notes/old.md\0?? Notes/new-note.md\0");
    expect(changes).toHaveLength(3);
    expect(changes[1]).toMatchObject({ path: "Notes/new.md", originalPath: "Notes/old.md", indexStatus: "R" });
    expect(changes[2]).toMatchObject({ untracked: true });
  });
});
