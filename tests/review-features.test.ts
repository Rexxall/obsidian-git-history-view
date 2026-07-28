import { describe, expect, it } from "vitest";
import { buildSemanticDiff } from "../src/diff/semantic-diff";
import {
  buildHunkRestoreTargets,
  buildFocusedSideItems,
  buildSideRows,
  compactLongFrontmatterPair,
  withoutBlankLines
} from "../src/ui/diff-renderer";
import {
  extractMarkdownBlocks,
  findBestMatchingBlock,
  replaceMarkdownBlock
} from "../src/history/markdown-blocks";
import { buildLinkImpact, extractNoteRelations } from "../src/analysis/link-impact";
import { buildResolvedConflict, parseConflictDocument } from "../src/conflict/conflict-parser";
import {
  contentFingerprint,
  groupEffectiveVersions,
  groupsSinceCheckpoint
} from "../src/history/version-groups";
import {
  buildTimelineWindow,
  expandTimelineLimit,
  limitHistory
} from "../src/history/timeline-window";
import {
  adjacentDistinctVersionReference,
  adjacentVersionReference,
  buildVersionSequence,
  versionReferencePosition
} from "../src/history/version-navigation";
import { buildChangeMap } from "../src/diff/change-map";
import { buildRenderedDiff, stripFrontmatter } from "../src/diff/rendered-diff";
import {
  groupWorkspaceChanges,
  workspaceChangePresentation,
  workspaceNoteLabel
} from "../src/workspace/change-presentation";
import {
  groupReviewInboxItems,
  isReviewPathExcluded,
  mergeReviewInboxItems,
  normalizeReviewExcludedPaths,
  reviewInboxItemMatchesFilter,
  reviewInboxPendingStatus
} from "../src/review/review-inbox";
import {
  markReviewInboxItemState,
  setReviewInboxItemSnoozed
} from "../src/review/review-state";
import {
  historicalContentMatch,
  historicalContentSnippet,
  searchableMarkdownBody
} from "../src/history/content-search";
import {
  parseCommittedNameStatus,
  parseLatestCommitByPath
} from "../src/git/parse-log";
import type {
  GitCommitVersion,
  GitCommittedChange,
  ReviewInboxItem,
  GitWorkspaceChange
} from "../src/models";

function commit(
  hash: string,
  authoredAt: string,
  subject: string,
  addedLines = 2,
  deletedLines = 1
): GitCommitVersion {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    authorName: "Writer",
    authorEmail: "writer@example.com",
    authoredAt,
    subject,
    historicalPath: "Note.md",
    changeType: "M",
    addedLines,
    deletedLines,
    trailers: {}
  };
}

describe("Markdown semantic diff", () => {
  it("summarizes properties, headings, tasks, and wiki links", () => {
    const before = `---\nstatus: draft\n---\n# Old\n- [ ] Read [[Paper A]]\n`;
    const after = `---\nstatus: reviewed\n---\n# New\n- [x] Read [[Paper B]]\n`;
    const changes = buildSemanticDiff(before, after);
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "属性", kind: "changed", label: "status" }),
      expect.objectContaining({ group: "标题", kind: "changed", label: "New" }),
      expect.objectContaining({ group: "任务", kind: "changed", label: "Read [[Paper B]]" }),
      expect.objectContaining({ group: "链接", kind: "removed", label: "Paper A" }),
      expect.objectContaining({ group: "链接", kind: "added", label: "Paper B" })
    ]));
  });

  it("compares multiline frontmatter fields without flattening the document", () => {
    const before = "---\ntags:\n  - research\n  - draft\nstatus: active\n---\n# Note\n";
    const after = "---\ntags:\n  - research\n  - reviewed\nstatus: active\n---\n# Note\n";
    const changes = buildSemanticDiff(before, after);

    expect(changes).toEqual([
      expect.objectContaining({
        group: "属性",
        kind: "changed",
        label: "tags",
        before: expect.stringContaining("draft"),
        after: expect.stringContaining("reviewed")
      })
    ]);
    expect(buildSemanticDiff(before, after, { ignoreFrontmatter: true })).toEqual([]);
  });

  it("previews very long property values instead of rendering the entire value", () => {
    const before = `---\ntranscript: ${"old ".repeat(200)}\n---\n# Note\n`;
    const after = `---\ntranscript: ${"new ".repeat(200)}\n---\n# Note\n`;
    const [change] = buildSemanticDiff(before, after);

    expect(change).toMatchObject({ group: "属性", kind: "changed", label: "transcript" });
    expect(change?.before).toContain("共 799 字符");
    expect(change?.after).toContain("共 799 字符");
    expect(change?.before?.length).toBeLessThan(280);
  });

  it("treats a renamed heading as one change without repeating its stable paragraph", () => {
    const before = "# Research plan\n\nStable explanation of the method.\n";
    const after = "# Study plan\n\nStable explanation of the method.\n";
    const changes = buildSemanticDiff(before, after);

    expect(changes).toEqual([
      expect.objectContaining({
        group: "标题",
        kind: "changed",
        before: "H1 · Research plan",
        after: "H1 · Study plan"
      })
    ]);
    expect(changes.some((change) => change.group === "段落")).toBe(false);
  });

  it("recognizes reordered list items and task-state evolution", () => {
    const before = "# Plan\n\n- First step\n- Second step\n- [ ] Submit application\n";
    const after = "# Plan\n\n- Second step\n- First step\n- [x] Submit application\n";
    const changes = buildSemanticDiff(before, after);

    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "列表", kind: "moved" }),
      expect.objectContaining({
        group: "任务",
        kind: "changed",
        label: "Submit application",
        before: "待办 · Submit application",
        after: "已完成 · Submit application"
      })
    ]));
  });

  it("reports table edits at cell level", () => {
    const before = "# Experiments\n\n| Name | State |\n| --- | --- |\n| A | draft |\n| B | ready |\n";
    const after = "# Experiments\n\n| Name | State |\n| --- | --- |\n| A | reviewed |\n| B | ready |\n";
    const changes = buildSemanticDiff(before, after);
    const table = changes.find((change) => change.group === "表格");

    expect(table).toMatchObject({
      kind: "changed",
      label: "表格 · Experiments",
      details: [
        {
          label: "第 1 行 · State",
          before: "draft",
          after: "reviewed"
        }
      ]
    });
  });

  it("separates Callout, code, Mermaid, and formula changes", () => {
    const before = [
      "> [!warning] Risk",
      "> Old warning.",
      "",
      "```ts",
      "const state = 'old';",
      "```",
      "",
      "```mermaid",
      "graph LR; A-->B;",
      "```",
      "",
      "$$x = 1$$"
    ].join("\n");
    const after = [
      "> [!warning] Risk",
      "> New warning.",
      "",
      "```ts",
      "const state = 'new';",
      "```",
      "",
      "```mermaid",
      "graph LR; A-->C;",
      "```",
      "",
      "$$x = 2$$"
    ].join("\n");
    const changes = buildSemanticDiff(before, after);

    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "Callout", kind: "changed", label: "WARNING · Risk" }),
      expect.objectContaining({ group: "代码", kind: "changed", label: "代码块 · ts" }),
      expect.objectContaining({ group: "代码", kind: "changed", label: "Mermaid 图" }),
      expect.objectContaining({ group: "公式", kind: "changed", label: "块级公式" })
    ]));
  });
});

describe("reading diff", () => {
  it("pairs rewritten Markdown blocks while preserving surrounding content", () => {
    const before = "# Note\n\nStable paragraph.\n\nOld explanation.\n";
    const after = "# Note\n\nStable paragraph.\n\nNew explanation with context.\n";
    const sections = buildRenderedDiff(before, after);

    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "unchanged" }),
      expect.objectContaining({
        kind: "changed",
        before: [expect.objectContaining({ content: "Old explanation." })],
        after: [expect.objectContaining({ content: "New explanation with context." })]
      })
    ]));
  });

  it("can ignore frontmatter and whitespace-only edits", () => {
    const before = "---\nupdated: old\n---\n\n# Note\n\nSame   words\n";
    const after = "---\nupdated: new\n---\n\n# Note\n\nSame words\n";
    const sections = buildRenderedDiff(before, after, {
      ignoreFrontmatter: true,
      ignoreWhitespace: true
    });

    expect(sections.every((section) => section.kind === "unchanged")).toBe(true);
    expect(stripFrontmatter(before)).toBe("# Note\n\nSame   words\n");
  });
});

describe("historical content search", () => {
  it("finds a remembered phrase and returns compact surrounding context", () => {
    const content = `# Research\n\n${"background ".repeat(20)}The deleted insight lives here.${" conclusion".repeat(20)}\n`;
    const snippet = historicalContentSnippet(content, "deleted insight", 28);

    expect(snippet).toContain("deleted insight");
    expect(snippet?.startsWith("…")).toBe(true);
    expect(snippet?.endsWith("…")).toBe(true);
    expect(snippet?.length).toBeLessThan(100);
  });

  it("prefers Markdown body matches and still labels property-only matches", () => {
    const content = "---\ntranscript: secret phrase\n---\n# Note\nVisible phrase\n";

    expect(searchableMarkdownBody(content)).toBe("# Note\nVisible phrase\n");
    expect(historicalContentMatch(content, "secret phrase")).toMatchObject({
      scope: "properties",
      snippet: expect.stringContaining("secret phrase")
    });
    expect(historicalContentMatch(content, "Visible phrase")).toMatchObject({
      scope: "body",
      snippet: expect.stringContaining("Visible phrase")
    });
  });

  it("matches Chinese text case-insensitively where applicable", () => {
    const content = "# 研究\n\n这个版本保留了关键研究问题。\n";

    expect(historicalContentSnippet(content, "关键研究问题")).toContain("这个版本保留了关键研究问题。");
    expect(historicalContentSnippet(content, "不存在内容")).toBeNull();
  });
});

describe("partial hunk restore", () => {
  it("restores one separated hunk without reverting another", () => {
    const padding = Array.from({ length: 12 }, (_, index) => `same ${index}`).join("\n");
    const historical = `top\nold first\n${padding}\nold second\nbottom\n`;
    const current = `top\nnew first\n${padding}\nnew second\nbottom\n`;
    const targets = buildHunkRestoreTargets(historical, current);

    expect(targets).toHaveLength(2);
    expect(targets[0]?.targetContent).toContain("old first");
    expect(targets[0]?.targetContent).toContain("new second");
    expect(targets[1]?.targetContent).toContain("new first");
    expect(targets[1]?.targetContent).toContain("old second");
  });
});

describe("focused side-by-side diff", () => {
  it("folds changed long frontmatter values while preserving source line numbers", () => {
    const before = `---\nstatus: draft\ntranscript: ${"before ".repeat(140)}\n---\n# Note\nold\n`;
    const after = `---\nstatus: draft\ntranscript: ${"after ".repeat(160)}\n---\n# Note\nnew\n`;
    const compacted = compactLongFrontmatterPair(before, after);
    const rows = buildSideRows(compacted.before, compacted.after, {
      ignoreWhitespace: false,
      ignoreBlankLines: true
    });

    expect(compacted.collapsedProperties).toEqual(["transcript"]);
    expect(compacted.before).not.toContain("before before");
    expect(compacted.after).not.toContain("after after");
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "changed",
        oldLineNumber: 3,
        newLineNumber: 3,
        oldText: expect.stringContaining("修改前"),
        newText: expect.stringContaining("修改后")
      }),
      expect.objectContaining({
        kind: "changed",
        oldLineNumber: 6,
        newLineNumber: 6,
        oldText: "old",
        newText: "new"
      })
    ]));
  });

  it("does not fold long Markdown body content outside frontmatter", () => {
    const body = "Body ".repeat(300);
    const compacted = compactLongFrontmatterPair(`# Note\n${body}`, `# Note\n${body}changed`);

    expect(compacted.collapsedProperties).toEqual([]);
    expect(compacted.before).toContain(body);
  });

  it("ignores blank lines while preserving original line numbers", () => {
    const before = "same\n\nold\n\nstable\n";
    const after = "same\n\nnew\nstable\n";
    const rows = buildSideRows(before, after, {
      ignoreWhitespace: false,
      ignoreBlankLines: true
    });

    expect(rows.some((row) => row.oldText === "" || row.newText === "")).toBe(false);
    expect(rows).toEqual([
      expect.objectContaining({ kind: "same", oldLineNumber: 1, newLineNumber: 1 }),
      expect.objectContaining({
        kind: "changed",
        oldLineNumber: 3,
        oldText: "old",
        newLineNumber: 3,
        newText: "new"
      }),
      expect.objectContaining({ kind: "same", oldLineNumber: 5, newLineNumber: 4 })
    ]);
  });

  it("removes whitespace-only lines without flattening meaningful indentation", () => {
    expect(withoutBlankLines("title\n   \n  nested\n\n")).toBe("title\n  nested\n");
  });

  it("drops unchanged leading and trailing content and compresses only internal gaps", () => {
    const rows = buildSideRows(
      "intro\nold one\nstable middle\nold two\noutro\n",
      "intro\nnew one\nstable middle\nnew two\noutro\n",
      { ignoreWhitespace: false, ignoreBlankLines: true }
    );
    const items = buildFocusedSideItems(rows);

    expect(items.map((item) => item.kind)).toEqual([
      "row",
      "omitted",
      "row"
    ]);
    expect(items[1]).toEqual({ kind: "omitted", count: 1 });
    expect(items.some((item) => item.kind === "row" && item.row.oldText === "intro")).toBe(false);
    expect(items.some((item) => item.kind === "row" && item.row.oldText === "outro")).toBe(false);
  });
});

describe("paragraph-level history", () => {
  it("tracks a moved Markdown paragraph and replaces only its current block", () => {
    const historical = "# Research\n\nImportant stable paragraph about predictive coding.\n\n## Notes\nOld note.\n";
    const current = "# Research\n\n## Notes\nRewritten note.\n\nImportant stable paragraph about predictive coding.\n";
    const currentBlock = extractMarkdownBlocks(current).at(-1)!;
    const match = findBestMatchingBlock(currentBlock, historical);

    expect(match?.block.content).toBe("Important stable paragraph about predictive coding.");
    expect(match?.score).toBeGreaterThan(0.9);

    const replaced = replaceMarkdownBlock(current, currentBlock, "Recovered paragraph.");
    expect(replaced).toContain("Rewritten note.");
    expect(replaced).toContain("Recovered paragraph.");
    expect(replaced).not.toContain("Important stable paragraph");
  });
});

describe("Obsidian relationship impact", () => {
  it("detects wiki links, embeds, Markdown links, and tags while ignoring external URLs", () => {
    const before = "See [[Old Note]], ![[figure.png]], [docs](Guide.md), #draft and [web](https://example.com).";
    const after = "See [[New Note|new]], ![[figure.png]], [docs](Guide.md), #reviewed.";
    const impact = buildLinkImpact(before, after);

    expect(impact.added).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "New Note", kind: "wikilink" }),
      expect.objectContaining({ target: "reviewed", kind: "tag" })
    ]));
    expect(impact.removed).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "Old Note", kind: "wikilink" }),
      expect.objectContaining({ target: "draft", kind: "tag" })
    ]));
    expect(extractNoteRelations(after).some((relation) => relation.target.includes("example.com"))).toBe(false);
  });
});

describe("three-way conflict resolution", () => {
  it("parses diff3 markers and resolves each hunk independently", () => {
    const conflicted = [
      "# Note\n",
      "<<<<<<< HEAD\n",
      "local paragraph\n",
      "||||||| base\n",
      "base paragraph\n",
      "=======\n",
      "remote paragraph\n",
      ">>>>>>> topic\n",
      "tail\n"
    ].join("");
    const document = parseConflictDocument(conflicted);
    expect(document.hunks).toHaveLength(1);
    expect(document.hunks[0]).toMatchObject({
      ours: "local paragraph\n",
      ancestor: "base paragraph\n",
      theirs: "remote paragraph\n"
    });
    const resolved = buildResolvedConflict(document, new Map([[1, "both"]]));
    expect(resolved).toBe("# Note\nlocal paragraph\nremote paragraph\ntail\n");
    expect(resolved).not.toContain("<<<<<<<");
  });
});

describe("meaningful Git versions", () => {
  it("folds adjacent automatic backups and identifies duplicate content", () => {
    const commits = [
      commit("aaaaaaaa", "2026-07-21T10:20:00+09:00", "Auto backup"),
      commit("bbbbbbbb", "2026-07-21T10:10:00+09:00", "Auto backup"),
      commit("cccccccc", "2026-07-20T09:00:00+09:00", "Write introduction", 30, 4)
    ];
    const contents = new Map([
      ["aaaaaaaa", "# Note\nSame content\n"],
      ["bbbbbbbb", "# Note\nSame content\n"],
      ["cccccccc", "# Note\nOld content\n"]
    ]);
    const groups = groupEffectiveVersions(commits, { bookmarks: {} }, contents);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.commits).toHaveLength(2);
    expect(groups[0]?.duplicateCount).toBe(1);
    expect(groups[0]?.summary).toContain("折叠 1 个重复版本");
  });

  it("keeps review checkpoints as milestones and returns only newer groups", () => {
    const commits = [
      commit("aaaaaaaa", "2026-07-21T10:20:00+09:00", "Auto backup"),
      commit("bbbbbbbb", "2026-07-21T10:10:00+09:00", "Auto backup"),
      commit("cccccccc", "2026-07-21T10:00:00+09:00", "Auto backup")
    ];
    const state = {
      bookmarks: {},
      reviewCheckpoint: {
        commitHash: "bbbbbbbb",
        historicalPath: "Note.md",
        reviewedAt: "2026-07-21T10:15:00+09:00"
      }
    };
    const groups = groupEffectiveVersions(commits, state);

    expect(groups.some((group) => group.commits.some((item) => item.hash === "bbbbbbbb") && group.isMilestone)).toBe(true);
    expect(groupsSinceCheckpoint(groups, "bbbbbbbb").flatMap((group) => group.commits).map((item) => item.hash)).toEqual(["aaaaaaaa"]);
  });

  it("creates stable working-content fingerprints", () => {
    expect(contentFingerprint("same")).toBe(contentFingerprint("same"));
    expect(contentFingerprint("same")).not.toBe(contentFingerprint("different"));
  });
});

describe("Markdown change map", () => {
  it("maps diff hunks to their nearest headings", () => {
    const before = "# Project\n\nOld intro.\n\n## Method\n\nOld method.\n";
    const after = "# Project\n\nNew intro.\n\n## Method\n\nNew method.\n\nExtra line.\n";
    const map = buildChangeMap(before, after);

    expect(map).toHaveLength(2);
    expect(map[0]).toMatchObject({ title: "Project", kind: "changed" });
    expect(map[1]).toMatchObject({ title: "Method", kind: "changed" });
    expect(map[1]!.addedLines).toBeGreaterThan(0);
  });
});

describe("timeline window", () => {
  it("renders long histories in predictable batches", () => {
    const history = Array.from({ length: 125 }, (_, index) => index);
    const first = buildTimelineWindow(history, 40);
    expect(first.items).toHaveLength(40);
    expect(first.remaining).toBe(85);
    expect(expandTimelineLimit(first.visible, first.total)).toBe(80);
    expect(expandTimelineLimit(120, first.total)).toBe(125);
  });

  it("detects when Git history exceeds the configured limit", () => {
    const limited = limitHistory([1, 2, 3, 4], 3);
    expect(limited.items).toEqual([1, 2, 3]);
    expect(limited.hasMore).toBe(true);
    expect(limitHistory([1, 2, 3], 3).hasMore).toBe(false);
  });
});

describe("version navigation", () => {
  const older = commit("11111111", "2026-07-20T10:00:00+09:00", "Older");
  const newer = commit("22222222", "2026-07-21T10:00:00+09:00", "Newer");
  const working = { kind: "working", label: "当前工作区" } as const;

  it("orders commits from oldest to working tree", () => {
    const sequence = buildVersionSequence([newer, older]);
    expect(sequence.map((reference) => reference.kind === "working" ? "working" : reference.commit.hash)).toEqual([
      older.hash,
      newer.hash,
      "working"
    ]);
  });

  it("moves each side backward and forward without leaving the sequence", () => {
    const current = { kind: "commit", commit: newer } as const;
    expect(adjacentVersionReference([newer, older], current, -1)).toMatchObject({
      kind: "commit",
      commit: { hash: older.hash }
    });
    expect(adjacentVersionReference([newer, older], current, 1)).toEqual(working);
    expect(adjacentVersionReference([newer, older], working, 1)).toBeNull();
    expect(versionReferencePosition([newer, older], current)).toEqual({ current: 2, total: 3 });
  });

  it("skips the version already selected on the other side", () => {
    const current = { kind: "commit", commit: newer } as const;
    const occupied = { kind: "commit", commit: older } as const;
    expect(adjacentDistinctVersionReference(
      [newer, older],
      current,
      -1,
      occupied
    )).toBeNull();
    expect(adjacentDistinctVersionReference(
      [newer, older],
      working,
      -1,
      current
    )).toMatchObject({
      kind: "commit",
      commit: { hash: older.hash }
    });
  });
});

describe("workspace change presentation", () => {
  const modified: GitWorkspaceChange = {
    path: "10 - Projects/日本医学博士申请/00_总控台/07_最新进展与跨窗口同步.md",
    indexStatus: " ",
    workTreeStatus: "M",
    untracked: false,
    conflicted: false,
    addedLines: 35,
    deletedLines: 1
  };

  it("puts the note name first and shortens the folder context", () => {
    expect(workspaceNoteLabel(modified.path)).toEqual({
      title: "07_最新进展与跨窗口同步",
      folder: "日本医学博士申请 / 00_总控台"
    });
  });

  it("uses human-facing states and stable group ordering", () => {
    const newNote = {
      ...modified,
      path: "Inbox/新笔记.md",
      indexStatus: "?",
      workTreeStatus: "?",
      untracked: true
    };
    expect(workspaceChangePresentation(modified).label).toBe("已修改");
    expect(groupWorkspaceChanges([newNote, modified]).map((group) => group.presentation.key)).toEqual([
      "modified",
      "new"
    ]);
  });
});

describe("full-vault review inbox", () => {
  const committed: GitCommittedChange = {
    path: "Notes/Research.md",
    changeType: "M",
    addedLines: 8,
    deletedLines: 2,
    latestCommit: {
      hash: "aaaaaaaa",
      shortHash: "aaaaaaa",
      authoredAt: "2026-07-24T09:30:00+09:00",
      subject: "Refine research plan"
    }
  };
  const working: GitWorkspaceChange = {
    path: "Notes/Research.md",
    indexStatus: " ",
    workTreeStatus: "M",
    untracked: false,
    conflicted: false,
    addedLines: 3,
    deletedLines: 1
  };

  it("merges committed and working changes into one review item", () => {
    const items = mergeReviewInboxItems([committed], [working], (path) => path);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      path: "Notes/Research.md",
      vaultPath: "Notes/Research.md",
      addedLines: 11,
      deletedLines: 3,
      committedChange: { changeType: "M" },
      workspaceChange: { workTreeStatus: "M" }
    });
  });

  it("excludes backup folders by normalized Vault-relative path", () => {
    const exclusions = normalizeReviewExcludedPaths(["backup/\nBackups", ".trash"]);
    expect(exclusions).toEqual(["backup", "backups", ".trash"]);
    expect(isReviewPathExcluded("backup/2026/Note.md", exclusions)).toBe(true);
    expect(isReviewPathExcluded("Projects/backup-plan.md", exclusions)).toBe(false);
  });

  it("groups attention, working, recent, and older changes in review order", () => {
    const base = mergeReviewInboxItems([committed], [working], (path) => path)[0]!;
    const conflict = {
      ...base,
      path: "Notes/Conflict.md",
      workspaceChange: { ...working, path: "Notes/Conflict.md", conflicted: true }
    };
    const recent: ReviewInboxItem = {
      ...base,
      path: "Notes/Recent.md",
      vaultPath: "Notes/Recent.md",
      latestCommit: {
        ...committed.latestCommit!,
        authoredAt: "2026-07-22T09:30:00+09:00"
      }
    };
    delete recent.workspaceChange;
    const older: ReviewInboxItem = {
      ...recent,
      path: "Notes/Older.md",
      vaultPath: "Notes/Older.md",
      latestCommit: {
        ...committed.latestCommit!,
        authoredAt: "2026-06-01T09:30:00+09:00"
      }
    };
    expect(
      groupReviewInboxItems(
        [older, recent, base, conflict],
        new Date("2026-07-24T12:00:00+09:00")
      ).map((group) => group.key)
    ).toEqual(["attention", "working", "recent", "older"]);
    expect(reviewInboxItemMatchesFilter(base, "working", false)).toBe(true);
    expect(reviewInboxItemMatchesFilter(base, "pending", true)).toBe(false);
    expect(reviewInboxItemMatchesFilter(base, "snoozed", true)).toBe(true);
  });

  it("parses rename-safe committed paths and latest commit metadata", () => {
    const changes = parseCommittedNameStatus(
      "M\0Notes/Current.md\0R100\0Notes/Old.md\0Notes/New.md\0"
    );
    expect(changes).toEqual([
      expect.objectContaining({ path: "Notes/Current.md", changeType: "M" }),
      expect.objectContaining({
        path: "Notes/New.md",
        originalPath: "Notes/Old.md",
        changeType: "R"
      })
    ]);

    const log = "\u001eaaaaaaaa\u001faaaaaaa\u001f2026-07-24T09:30:00+09:00\u001fUpdate note\u001d\nM\tNotes/Current.md\n";
    expect(parseLatestCommitByPath(log).get("Notes/Current.md")).toEqual({
      hash: "aaaaaaaa",
      shortHash: "aaaaaaa",
      authoredAt: "2026-07-24T09:30:00+09:00",
      subject: "Update note"
    });
  });

  it("keeps snooze and reviewed state stable across a plugin-data reload", () => {
    const item = mergeReviewInboxItems([committed], [working], (path) => path)[0]!;
    const workingFingerprint = contentFingerprint("working content");
    const state = { bookmarks: {} };

    setReviewInboxItemSnoozed(state, "2026-07-25T12:00:00+09:00");
    const snoozedState = JSON.parse(JSON.stringify(state));
    expect(reviewInboxPendingStatus(
      item,
      snoozedState,
      committed.latestCommit!.hash,
      workingFingerprint,
      new Date("2026-07-24T12:00:00+09:00")
    )).toMatchObject({
      committedPending: true,
      workingPending: true,
      snoozed: true
    });

    markReviewInboxItemState(
      snoozedState,
      item.path,
      committed.latestCommit,
      workingFingerprint,
      "2026-07-24T12:05:00+09:00"
    );
    const reloadedState = JSON.parse(JSON.stringify(snoozedState));
    expect(reviewInboxPendingStatus(
      item,
      reloadedState,
      committed.latestCommit!.hash,
      workingFingerprint,
      new Date("2026-07-24T12:06:00+09:00")
    )).toEqual({
      committedPending: false,
      workingPending: false,
      snoozed: false
    });
    expect(reviewInboxPendingStatus(
      item,
      reloadedState,
      committed.latestCommit!.hash,
      contentFingerprint("new working content"),
      new Date("2026-07-24T12:07:00+09:00")
    ).workingPending).toBe(true);
  });
});
