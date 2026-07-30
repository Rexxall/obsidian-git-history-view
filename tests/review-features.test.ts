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
  historyActivationMode,
  isHistoryRowActivationKey,
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
  buildContentLifecycle,
  historicalContentMatch,
  historicalContentSnippet,
  searchableMarkdownBody
} from "../src/history/content-search";
import {
  buildPathTransitions,
  compactHistoryPath
} from "../src/history/path-history";
import {
  hasNamedMilestone,
  milestoneSearchText,
  milestonesForCommit,
  namedMilestoneCommits,
  previousNamedMilestone,
  setReviewCheckpointMilestone,
  storedMilestoneCommitSnapshots
} from "../src/history/milestones";
import {
  CURRENT_DATA_SCHEMA_VERSION,
  mergeFileReviewStates,
  migratePluginData,
  migrateReviewStatePath,
  remapVaultPath,
  reviewStateKey
} from "../src/persistence/plugin-data";
import {
  parseCommittedNameStatus,
  parseLatestCommitByPath
} from "../src/git/parse-log";
import type {
  GitCommitVersion,
  GitCommittedChange,
  FileReviewState,
  GitRepositoryContext,
  ReviewInboxItem,
  VersionMilestone,
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

  it("locates a phrase's first appearance and confirmed deletion boundary", () => {
    const lifecycle = buildContentLifecycle([
      { key: "a", state: "absent" },
      { key: "b", state: "present" },
      { key: "c", state: "present" },
      { key: "d", state: "absent" },
      { key: "working", state: "absent" }
    ]);

    expect(lifecycle).toMatchObject({
      firstAppearanceKey: "b",
      lastPresenceKey: "c",
      currentPresent: false,
      confirmedReappearances: 0,
      unknownVersions: 0
    });
    expect(lifecycle.spans).toEqual([
      expect.objectContaining({
        firstKey: "b",
        lastKey: "c",
        introducedAfterKey: "a",
        removedByKey: "d"
      })
    ]);
  });

  it("tracks confirmed reappearances and current working-tree presence", () => {
    const lifecycle = buildContentLifecycle([
      { key: "a", state: "present" },
      { key: "b", state: "absent" },
      { key: "c", state: "present" },
      { key: "working", state: "present" }
    ]);

    expect(lifecycle.currentPresent).toBe(true);
    expect(lifecycle.confirmedReappearances).toBe(1);
    expect(lifecycle.lastPresenceKey).toBe("working");
    expect(lifecycle.spans[0]?.removedByKey).toBe("b");
    expect(lifecycle.spans[1]?.introducedAfterKey).toBe("b");
  });

  it("does not infer additions or deletions across unreadable versions", () => {
    const lifecycle = buildContentLifecycle([
      { key: "a", state: "unknown" },
      { key: "b", state: "present" },
      { key: "c", state: "unknown" },
      { key: "working", state: "absent" }
    ]);

    expect(lifecycle.unknownVersions).toBe(2);
    expect(lifecycle.spans[0]).toMatchObject({
      uncertainStart: true,
      uncertainEnd: true
    });
    expect(lifecycle.spans[0]?.introducedAfterKey).toBeUndefined();
    expect(lifecycle.spans[0]?.removedByKey).toBeUndefined();
  });

  it("uses the working tree as an uncommitted addition or deletion boundary", () => {
    const deletedInWorkingTree = buildContentLifecycle([
      { key: "a", state: "absent" },
      { key: "b", state: "present" },
      { key: "working", state: "absent" }
    ]);
    const addedInWorkingTree = buildContentLifecycle([
      { key: "a", state: "absent" },
      { key: "working", state: "present" }
    ]);

    expect(deletedInWorkingTree.spans[0]?.removedByKey).toBe("working");
    expect(addedInWorkingTree.spans[0]?.introducedAfterKey).toBe("a");
    expect(addedInWorkingTree.firstAppearanceKey).toBe("working");
  });
});

describe("note path history", () => {
  it("builds chronological rename and copy transitions from newest-first history", () => {
    const newest = {
      ...commit("dddddddd", "2026-07-14T10:00:00+09:00", "Edit current"),
      historicalPath: "Projects/Current.md"
    };
    const renamed = {
      ...commit("cccccccc", "2026-07-13T10:00:00+09:00", "Rename note"),
      historicalPath: "Projects/Current.md",
      changeType: "R"
    };
    const copied = {
      ...commit("bbbbbbbb", "2026-07-12T10:00:00+09:00", "Copy source"),
      historicalPath: "Archive/Original.md",
      changeType: "C"
    };
    const original = {
      ...commit("aaaaaaaa", "2026-07-11T10:00:00+09:00", "Create source"),
      historicalPath: "Sources/Seed.md"
    };

    const transitions = buildPathTransitions([newest, renamed, copied, original]);

    expect(transitions).toEqual([
      expect.objectContaining({
        kind: "copy",
        fromPath: "Sources/Seed.md",
        toPath: "Archive/Original.md",
        commit: expect.objectContaining({ hash: "bbbbbbbb" })
      }),
      expect.objectContaining({
        kind: "rename",
        fromPath: "Archive/Original.md",
        toPath: "Projects/Current.md",
        commit: expect.objectContaining({ hash: "cccccccc" })
      })
    ]);
  });

  it("keeps short paths readable without hiding their full identity", () => {
    expect(compactHistoryPath("Projects/Research/Current.md")).toBe("…/Research/Current.md");
    expect(compactHistoryPath("Notes/Current.md")).toBe("Notes/Current.md");
  });
});

describe("named version milestones", () => {
  const milestone = (
    id: string,
    hash: string,
    kind: VersionMilestone["kind"],
    label: string,
    occurredAt = "2026-07-29T03:00:00.000Z"
  ): VersionMilestone => ({
    id,
    kind,
    label,
    commitHash: hash,
    historicalPath: "Note.md",
    commitAuthoredAt: "2026-07-28T03:00:00.000Z",
    commitSubject: "Update note",
    occurredAt,
    createdAt: "2026-07-29T03:05:00.000Z",
    source: "local-user"
  });

  it("migrates legacy labels and review checkpoints into an idempotent schema", () => {
    const legacy = {
      settings: { maxCommits: 100 },
      fileReviewStates: {
        "repo\u001fNote.md": {
          bookmarks: {
            aaaaaaaa: {
              label: "已发送",
              createdAt: "2026-07-28T10:00:00+09:00"
            }
          },
          reviewCheckpoint: {
            commitHash: "bbbbbbbb",
            historicalPath: "Note.md",
            reviewedAt: "2026-07-29T10:00:00+09:00",
            workingFingerprint: "fingerprint"
          }
        }
      }
    };

    const first = migratePluginData(legacy);
    const second = migratePluginData(first);
    const state = second.fileReviewStates!["repo\u001fNote.md"]!;
    const milestones = Object.values(state.milestones ?? {});

    expect(second.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    expect(second).toEqual(first);
    expect(milestones).toHaveLength(2);
    expect(milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "legacy-bookmark:aaaaaaaa",
        kind: "sent",
        commitHash: "aaaaaaaa",
        source: "legacy-bookmark"
      }),
      expect.objectContaining({
        kind: "review-checkpoint",
        commitHash: "bbbbbbbb",
        source: "review-checkpoint"
      })
    ]));
    expect(state.reviewCheckpointId).toBe(state.reviewCheckpoint?.milestoneId);
  });

  it("leaves data from a future schema untouched", () => {
    const future = {
      schemaVersion: CURRENT_DATA_SCHEMA_VERSION + 1,
      futureOnly: { retained: true },
      fileReviewStates: {
        note: {
          futureStateField: "keep-me"
        }
      }
    };

    expect(migratePluginData(future)).toEqual(future);
  });

  it("migrates schema v4 local snapshots and rejects tampered content", () => {
    const validContent = "Saved locally";
    const migrated = migratePluginData({
      schemaVersion: 4,
      localSnapshots: {
        valid: {
          schemaVersion: 1,
          id: "valid",
          filePath: "Notes/A.md",
          label: "Before rewrite",
          capturedAt: "2026-07-30T05:00:00.000Z",
          content: validContent,
          contentFingerprint: contentFingerprint(validContent)
        },
        tampered: {
          schemaVersion: 1,
          id: "tampered",
          filePath: "Notes/A.md",
          label: "Broken",
          capturedAt: "2026-07-30T04:00:00.000Z",
          content: "changed",
          contentFingerprint: contentFingerprint("original")
        }
      }
    });

    expect(migrated.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    expect(Object.keys(migrated.localSnapshots ?? {})).toEqual(["valid"]);
    expect(migratePluginData(migrated)).toEqual(migrated);
  });

  it("does not re-import schema v2 bookmark projections as duplicate milestones", () => {
    const state: FileReviewState = {
      bookmarks: {
        aaaaaaaa: {
          label: "申请 PDF",
          createdAt: "2026-07-29T03:05:00.000Z",
          kind: "exported",
          historicalPath: "Note.md"
        }
      },
      milestones: {
        sent: milestone("sent", "aaaaaaaa", "sent", "发给导师"),
        exported: milestone("exported", "aaaaaaaa", "exported", "申请 PDF")
      }
    };
    const once = migratePluginData({
      schemaVersion: CURRENT_DATA_SCHEMA_VERSION,
      fileReviewStates: { note: state }
    });
    const twice = migratePluginData(once);

    expect(Object.keys(twice.fileReviewStates!.note!.milestones ?? {}).sort())
      .toEqual(["exported", "sent"]);
    expect(twice).toEqual(once);
  });

  it("allows multiple real-world events on the same commit", () => {
    const state: FileReviewState = {
      bookmarks: {},
      milestones: {
        sent: milestone("sent", "aaaaaaaa", "sent", "发给导师"),
        exported: milestone("exported", "aaaaaaaa", "exported", "申请 PDF")
      }
    };

    expect(milestonesForCommit(state, "aaaaaaaa", {
      includeReviewCheckpoint: false
    }).map((item) => item.kind)).toEqual(["exported", "sent"]);
    expect(hasNamedMilestone(state, "aaaaaaaa")).toBe(true);
    expect(milestoneSearchText(state, "aaaaaaaa")).toContain("申请 PDF");
  });

  it("finds the previous event by Git order instead of backfilled event time", () => {
    const newest = commit("cccccccc", "2026-07-29T12:00:00+09:00", "Newest");
    const middle = commit("bbbbbbbb", "2026-07-28T12:00:00+09:00", "Middle");
    const oldest = commit("aaaaaaaa", "2026-07-27T12:00:00+09:00", "Oldest");
    const state: FileReviewState = {
      bookmarks: {},
      milestones: {
        middle: milestone("middle", middle.hash, "sent", "后补记发送", "2026-07-01T00:00:00.000Z"),
        oldest: milestone("oldest", oldest.hash, "sent", "更早版本", "2026-07-30T00:00:00.000Z")
      }
    };

    expect(previousNamedMilestone(
      [newest, middle, oldest],
      state,
      newest.hash,
      "sent"
    )?.commit.hash).toBe(middle.hash);
    expect(previousNamedMilestone(
      [newest, middle, oldest],
      state,
      "not-in-loaded-history",
      "sent"
    )).toBeUndefined();
    expect(namedMilestoneCommits([newest, middle, oldest], state).map((item) => item.hash))
      .toEqual([middle.hash, oldest.hash]);
  });

  it("keeps stored milestone snapshots reachable beyond the history read limit", () => {
    const visible = commit("bbbbbbbb", "2026-07-29T12:00:00+09:00", "Visible");
    const old = milestone("old", "aaaaaaaa", "sent", "发给导师");
    old.commitAuthoredAt = "2026-06-01T03:00:00.000Z";
    old.commitSubject = "Older delivery";
    const state: FileReviewState = {
      bookmarks: {},
      milestones: { old }
    };

    expect(storedMilestoneCommitSnapshots(state, [visible])).toEqual([
      expect.objectContaining({
        hash: "aaaaaaaa",
        subject: "Older delivery",
        historicalPath: "Note.md"
      })
    ]);
    expect(storedMilestoneCommitSnapshots(state, [
      visible,
      commit("aaaaaaaa", "2026-06-01T12:00:00+09:00", "Already loaded")
    ])).toEqual([]);
  });

  it("keeps identical milestone versions as separate effective groups", () => {
    const newest = commit("bbbbbbbb", "2026-07-29T12:00:00+09:00", "Auto backup");
    const older = commit("aaaaaaaa", "2026-07-29T11:50:00+09:00", "Auto backup");
    const state: FileReviewState = {
      bookmarks: {},
      milestones: {
        sent: milestone("sent", older.hash, "sent", "已发送")
      }
    };
    const contents = new Map([
      [newest.hash, "# Same\n"],
      [older.hash, "# Same\n"]
    ]);

    expect(groupEffectiveVersions([newest, older], state, contents)).toHaveLength(2);
  });

  it("moves the system review milestone instead of accumulating checkpoints", () => {
    const state: FileReviewState = { bookmarks: {}, milestones: {} };
    const first = commit("aaaaaaaa", "2026-07-28T12:00:00+09:00", "First");
    const second = commit("bbbbbbbb", "2026-07-29T12:00:00+09:00", "Second");

    setReviewCheckpointMilestone(state, first, "2026-07-28T13:00:00.000Z");
    setReviewCheckpointMilestone(state, second, "2026-07-29T13:00:00.000Z", "working");

    const checkpoints = Object.values(state.milestones ?? {}).filter(
      (item) => item.kind === "review-checkpoint"
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      commitHash: second.hash,
      workingFingerprint: "working"
    });
    expect(state.reviewCheckpoint?.milestoneId).toBe(state.reviewCheckpointId);
  });

  it("merges rename states without overwriting milestones at the destination path", () => {
    const source: FileReviewState = {
      bookmarks: {},
      milestones: {
        sent: milestone("sent", "aaaaaaaa", "sent", "已发送")
      }
    };
    const target: FileReviewState = {
      bookmarks: {},
      milestones: {
        confirmed: milestone("confirmed", "bbbbbbbb", "confirmed", "已确认")
      }
    };

    const merged = mergeFileReviewStates(source, target);
    expect(Object.keys(merged.milestones ?? {})).toEqual(["sent", "confirmed"]);
    expect(Object.keys(merged.bookmarks)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("preserves both rename milestones when their stored IDs collide", () => {
    const source: FileReviewState = {
      bookmarks: {},
      milestones: {
        shared: milestone("shared", "aaaaaaaa", "sent", "已发送")
      }
    };
    const target: FileReviewState = {
      bookmarks: {},
      milestones: {
        shared: milestone("shared", "bbbbbbbb", "confirmed", "已确认")
      }
    };

    const merged = mergeFileReviewStates(source, target);
    expect(Object.values(merged.milestones ?? {}).map((item) => item.label).sort())
      .toEqual(["已发送", "已确认"]);
    expect(Object.keys(merged.milestones ?? {})).toEqual([
      "shared",
      "shared:merged:2"
    ]);
  });

  it("remaps only an exact path or a true folder descendant", () => {
    expect(remapVaultPath("Notes/Old.md", "Notes/Old.md", "Notes/New.md"))
      .toBe("Notes/New.md");
    expect(remapVaultPath("Notes/Old/note.md", "Notes/Old", "Archive/New", true))
      .toBe("Archive/New/note.md");
    expect(remapVaultPath("Notes/Older/note.md", "Notes/Old", "Archive/New", true))
      .toBe("Notes/Older/note.md");
    expect(remapVaultPath("Notes/Old/note.md", "Notes/Old", "Archive/New"))
      .toBe("Notes/Old/note.md");
  });

  it("moves every folder review state and merges destination collisions", () => {
    const context = (
      repositoryRelativePath: string
    ): GitRepositoryContext => ({
      vaultRoot: "/vault",
      repositoryRoot: "/repo",
      repositoryRelativePath
    });
    const sourceKey = reviewStateKey(context("Notes/Old/note.md"));
    const destinationKey = reviewStateKey(context("Archive/New/note.md"));
    const unrelatedKey = reviewStateKey(context("Notes/Older/note.md"));
    const states: Record<string, FileReviewState> = {
      [sourceKey]: {
        bookmarks: {},
        milestones: {
          shared: milestone("shared", "aaaaaaaa", "sent", "已发送")
        }
      },
      [destinationKey]: {
        bookmarks: {},
        milestones: {
          shared: milestone("shared", "bbbbbbbb", "confirmed", "已确认")
        }
      },
      [unrelatedKey]: {
        bookmarks: {},
        milestones: {
          stable: milestone("stable", "cccccccc", "custom", "不应移动")
        }
      }
    };

    expect(migrateReviewStatePath(
      states,
      context("Notes/Old"),
      context("Archive/New"),
      true
    )).toBe(true);
    expect(states[sourceKey]).toBeUndefined();
    expect(Object.values(states[destinationKey]?.milestones ?? {})
      .map((item) => item.label)
      .sort()).toEqual(["已发送", "已确认"]);
    expect(states[unrelatedKey]?.milestones?.stable?.label).toBe("不应移动");
  });

  it("keeps only the truly latest review checkpoint when rename states merge", () => {
    const source: FileReviewState = { bookmarks: {}, milestones: {} };
    const target: FileReviewState = { bookmarks: {}, milestones: {} };
    const sourceCommit = commit("aaaaaaaa", "2026-07-29T11:00:00+09:00", "Source");
    const targetCommit = commit("bbbbbbbb", "2026-07-29T12:00:00+09:00", "Target");
    setReviewCheckpointMilestone(
      source,
      sourceCommit,
      "2026-07-29T14:00:00+09:00"
    );
    source.reviewCheckpointId = "source-checkpoint";
    source.reviewCheckpoint!.milestoneId = "source-checkpoint";
    source.milestones!["source-checkpoint"] = {
      ...source.milestones!["review-checkpoint"]!,
      id: "source-checkpoint"
    };
    delete source.milestones!["review-checkpoint"];
    setReviewCheckpointMilestone(
      target,
      targetCommit,
      "2026-07-29T05:30:00.000Z"
    );
    target.reviewCheckpointId = "target-checkpoint";
    target.reviewCheckpoint!.milestoneId = "target-checkpoint";
    target.milestones!["target-checkpoint"] = {
      ...target.milestones!["review-checkpoint"]!,
      id: "target-checkpoint"
    };
    delete target.milestones!["review-checkpoint"];

    const merged = mergeFileReviewStates(source, target);
    const checkpoints = Object.values(merged.milestones ?? {}).filter(
      (item) => item.kind === "review-checkpoint"
    );

    expect(checkpoints).toHaveLength(1);
    expect(merged.reviewCheckpoint).toMatchObject({
      commitHash: targetCommit.hash,
      milestoneId: "target-checkpoint",
      reviewedAt: "2026-07-29T05:30:00.000Z"
    });
    expect(checkpoints[0]?.commitHash).toBe(merged.reviewCheckpoint?.commitHash);
  });

  it("drops malformed milestone data without preventing plugin startup", () => {
    const data = migratePluginData({
      fileReviewStates: {
        broken: {
          bookmarks: { bad: 42 },
          milestones: {
            missingHash: { id: "missingHash", label: "Broken" },
            valid: milestone("valid", "aaaaaaaa", "custom", "Kept")
          }
        }
      }
    });

    expect(Object.keys(data.fileReviewStates!.broken!.milestones ?? {})).toEqual(["valid"]);
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

  it("keeps malformed percent-encoded historical links inspectable", () => {
    expect(() => extractNoteRelations("See [[Broken%ZZLink]] and [note](Bad%2.md).")).not.toThrow();
    expect(extractNoteRelations("See [[Broken%ZZLink]] and [note](Bad%2.md).")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "Broken%ZZLink", kind: "wikilink" }),
        expect.objectContaining({ target: "Bad%2.md", kind: "markdown" })
      ])
    );
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

  it("keeps Git copy boundaries as separate milestones", () => {
    const copied = {
      ...commit("aaaaaaaa", "2026-07-21T10:20:00+09:00", "Auto backup"),
      changeType: "C"
    };
    const earlier = commit("bbbbbbbb", "2026-07-21T10:10:00+09:00", "Auto backup");
    const groups = groupEffectiveVersions([copied, earlier], { bookmarks: {} });

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      isMilestone: true,
      summary: "从其他笔记复制"
    });
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

  it("normalizes keyboard activation keys regardless of casing", () => {
    expect(historyActivationMode("Enter")).toBe("detail");
    expect(historyActivationMode("enter")).toBe("detail");
    expect(historyActivationMode("Return")).toBe("detail");
    expect(historyActivationMode("d")).toBe("detail");
    expect(historyActivationMode("P")).toBe("preview");
    expect(historyActivationMode("Tab")).toBeNull();
    expect(isHistoryRowActivationKey("Enter")).toBe(true);
    expect(isHistoryRowActivationKey("Return")).toBe(true);
    expect(isHistoryRowActivationKey(" ")).toBe(true);
    expect(isHistoryRowActivationKey("space")).toBe(true);
    expect(isHistoryRowActivationKey("d")).toBe(false);
  });

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
