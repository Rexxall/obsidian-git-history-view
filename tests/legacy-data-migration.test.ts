import { describe, expect, it } from "vitest";
import {
  CURRENT_DATA_SCHEMA_VERSION,
  REVIEW_STATE_KEY_SEPARATOR,
  migratePluginData,
  rehomeMovedRepositoryStates
} from "../src/persistence/plugin-data";
import type { FileReviewState } from "../src/models";
import { contentFingerprint } from "../src/history/version-groups";

// The shape of a real 0.7.6 data file with every value replaced: no real paths, notes or content.
const key = (root: string, file: string) => [root, file].join(REVIEW_STATE_KEY_SEPARATOR);
const OLD_ROOT = "/Users/old-user/Vaults/Main";
const NEW_ROOT = "/Users/new-user/Vaults/Main";

function legacy076() {
  return {
    schemaVersion: 6,
    settings: {
      gitExecutable: "git",
      repositoryRoot: "",
      maxCommits: 100,
      defaultDetailMode: "preview",
      density: "comfortable",
      reviewExcludedPaths: ["a", "b"],
      historyIgnoredProperties: ["updated"],
      historyGeneratedProperties: ["checksum"],
      useBlameIgnoreRevs: true
    },
    undoStack: [],
    restoreReceipts: [],
    recoveryBaskets: {},
    historicalSandboxes: {},
    localSnapshots: {
      "snap-1": {
        schemaVersion: 1,
        id: "snap-1",
        filePath: "Folder/Note.md",
        label: "手动快照",
        capturedAt: "2026-07-01T00:00:00.000Z",
        content: "placeholder body",
        contentFingerprint: contentFingerprint("placeholder body"),
        sourceModifiedAt: "2026-07-01T00:00:00.000Z"
      }
    },
    reviewAnnotations: {},
    fileReviewStates: {
      [key(OLD_ROOT, "Folder/Note.md")]: { bookmarks: {}, milestones: {}, detailMode: "preview" },
      [key(NEW_ROOT, "Folder/Other.md")]: { bookmarks: {}, milestones: {} }
    }
  };
}

describe("0.7.6 data", () => {
  it("loads settings, snapshots and review states and drops the old bookmark projection", () => {
    const data = migratePluginData(legacy076());
    expect(data.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    expect(data.settings?.defaultDetailMode).toBe("preview");
    expect(data.settings?.reviewExcludedPaths).toEqual(["a", "b"]);
    expect(Object.keys(data.localSnapshots ?? {})).toEqual(["snap-1"]);
    expect(Object.keys(data.fileReviewStates ?? {})).toHaveLength(2);
    for (const state of Object.values(data.fileReviewStates ?? {})) {
      expect(state).not.toHaveProperty("bookmarks");
    }
    expect(data.fileReviewStates?.[key(OLD_ROOT, "Folder/Note.md")]?.detailMode).toBe("preview");
  });

  it("turns v1 bookmarks into milestones", () => {
    const data = migratePluginData({
      schemaVersion: 1,
      fileReviewStates: {
        [key(NEW_ROOT, "Note.md")]: { bookmarks: { abcdef12: { label: "已发送", createdAt: "2026-01-01T00:00:00.000Z" } } }
      }
    });
    const milestones = Object.values(data.fileReviewStates?.[key(NEW_ROOT, "Note.md")]?.milestones ?? {});
    expect(milestones.map((milestone) => [milestone.commitHash, milestone.label, milestone.kind]))
      .toEqual([["abcdef12", "已发送", "sent"]]);
  });
});

describe("review states from a vault that moved", () => {
  it("moves states whose old root is gone onto the current root and merges duplicates", () => {
    const states: Record<string, FileReviewState> = {
      [key(OLD_ROOT, "Folder/Note.md")]: { milestones: {}, detailMode: "preview" },
      [key(OLD_ROOT, "Folder/Other.md")]: { milestones: {} },
      [key(NEW_ROOT, "Folder/Other.md")]: { milestones: {}, detailMode: "unified" }
    };
    expect(rehomeMovedRepositoryStates(states, NEW_ROOT, () => false)).toBe(true);
    expect(Object.keys(states).sort()).toEqual([key(NEW_ROOT, "Folder/Note.md"), key(NEW_ROOT, "Folder/Other.md")]);
    expect(states[key(NEW_ROOT, "Folder/Note.md")]?.detailMode).toBe("preview");
    expect(rehomeMovedRepositoryStates(states, NEW_ROOT, () => false)).toBe(false);
  });

  it("leaves states of other repositories, and of roots that still exist, alone", () => {
    const states: Record<string, FileReviewState> = {
      [key("/elsewhere/Other", "Note.md")]: { milestones: {} },
      [key(OLD_ROOT, "Note.md")]: { milestones: {} }
    };
    expect(rehomeMovedRepositoryStates(states, NEW_ROOT, (root) => root === OLD_ROOT)).toBe(false);
    expect(Object.keys(states)).toHaveLength(2);
  });
});
