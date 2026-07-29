import { describe, expect, it } from "vitest";
import {
  parseCommitMetadata,
  parseGitLog,
  parseGitStatus,
  parseNumStatByPath,
  parseNumStatLog,
  parseZeroDelimitedNumStat,
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

  it("tracks the source path when Git follows a copied note", () => {
    const raw =
      `${RS}aaaaaaaa${FS}aaaaaaa${FS}Alice${FS}alice@example.com${FS}2026-07-15T12:00:00+09:00${FS}Edit copied note\nM\tNotes/copied.md\n` +
      `${RS}bbbbbbbb${FS}bbbbbbb${FS}Alice${FS}alice@example.com${FS}2026-07-14T12:00:00+09:00${FS}Copy note\nC072\tNotes/source.md\tNotes/copied.md\n` +
      `${RS}cccccccc${FS}ccccccc${FS}Alice${FS}alice@example.com${FS}2026-07-13T12:00:00+09:00${FS}Original note\nA\tNotes/source.md\n`;

    const commits = parseGitLog(raw, "Notes/copied.md");

    expect(commits.map((commit) => commit.historicalPath)).toEqual([
      "Notes/copied.md",
      "Notes/copied.md",
      "Notes/source.md"
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

  it("keeps Unicode workspace paths aligned with Git status output", () => {
    const stats = parseNumStatByPath("35\t1\t10 - Projects/日本医学博士申请/最新进展.md\n");
    expect(stats.get("10 - Projects/日本医学博士申请/最新进展.md")).toMatchObject({
      addedLines: 35,
      deletedLines: 1
    });
  });

  it("parses NUL-delimited numstat paths without treating tabs as separators", () => {
    const entries = parseZeroDelimitedNumStat(
      "35\t1\t10 - Projects/日本医学博士申请/含\t制表符.md\0"
    );

    expect(entries).toEqual([
      {
        path: "10 - Projects/日本医学博士申请/含\t制表符.md",
        addedLines: 35,
        deletedLines: 1,
        binary: false
      }
    ]);
  });

  it("parses the extra NUL path records used by rename and copy numstat output", () => {
    const entries = parseZeroDelimitedNumStat(
      "2\t3\t\0Notes/旧名字.md\0Notes/新名字.md\0"
      + "4\t0\t\0Notes/source.md\0Notes/copy.md\0"
    );

    expect(entries).toEqual([
      {
        path: "Notes/新名字.md",
        originalPath: "Notes/旧名字.md",
        addedLines: 2,
        deletedLines: 3,
        binary: false
      },
      {
        path: "Notes/copy.md",
        originalPath: "Notes/source.md",
        addedLines: 4,
        deletedLines: 0,
        binary: false
      }
    ]);
  });

  it("marks NUL-delimited binary numstat entries", () => {
    expect(parseZeroDelimitedNumStat("-\t-\tAttachments/图像.png\0")).toEqual([
      {
        path: "Attachments/图像.png",
        addedLines: 0,
        deletedLines: 0,
        binary: true
      }
    ]);
  });

  it("ignores incomplete or malformed NUL-delimited numstat records", () => {
    expect(parseZeroDelimitedNumStat("not-a-numstat-record\0")).toEqual([]);
    expect(parseZeroDelimitedNumStat("1\t2\t\0only-old-path\0")).toEqual([]);
  });

  it("parses zero-delimited workspace status including rename", () => {
    const changes = parseWorkspaceStatus(" M Notes/a.md\0R  Notes/new.md\0Notes/old.md\0?? Notes/new-note.md\0");
    expect(changes).toHaveLength(3);
    expect(changes[1]).toMatchObject({ path: "Notes/new.md", originalPath: "Notes/old.md", indexStatus: "R" });
    expect(changes[2]).toMatchObject({ untracked: true });
  });

  it("keeps the source path for worktree-side renames and copies", () => {
    expect(parseWorkspaceStatus(" R Notes/new.md\0Notes/old.md\0")).toEqual([
      expect.objectContaining({
        path: "Notes/new.md",
        originalPath: "Notes/old.md",
        indexStatus: " ",
        workTreeStatus: "R"
      })
    ]);
  });
});

describe("parseCommitMetadata", () => {
  it("parses a root commit with no parents and a multiline body", () => {
    const raw =
      `aaaaaaaa${FS}aaaaaaa${FS}${FS}Alice${FS}alice@example.com`
      + `${FS}2026-07-15T12:00:00+09:00${FS}2026-07-15T12:01:00+09:00`
      + `${FS}Initial notes${FS}Initial notes\n\nAuthority: working_master\n`;

    expect(parseCommitMetadata(raw)).toEqual({
      hash: "aaaaaaaa",
      shortHash: "aaaaaaa",
      parentHashes: [],
      authorName: "Alice",
      authorEmail: "alice@example.com",
      authoredAt: "2026-07-15T12:00:00+09:00",
      committedAt: "2026-07-15T12:01:00+09:00",
      subject: "Initial notes",
      body: "Initial notes\n\nAuthority: working_master"
    });
  });

  it("parses every parent of a merge commit", () => {
    const raw =
      `${RS}\ncccccccc${FS}ccccccc${FS}aaaaaaaa bbbbbbbb${FS}Merge Bot`
      + `${FS}merge@example.com${FS}2026-07-16T09:00:00+09:00`
      + `${FS}2026-07-16T09:02:00+09:00${FS}Merge notes${FS}Merge notes`;

    expect(parseCommitMetadata(raw)).toMatchObject({
      hash: "cccccccc",
      parentHashes: ["aaaaaaaa", "bbbbbbbb"],
      committedAt: "2026-07-16T09:02:00+09:00",
      subject: "Merge notes",
      body: "Merge notes"
    });
  });

  it("rejects incomplete metadata records", () => {
    expect(parseCommitMetadata("aaaaaaaa\u001faaaaaaa")).toBeNull();
  });
});
