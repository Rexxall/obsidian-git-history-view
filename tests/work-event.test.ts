import { describe, expect, it } from "vitest";
import {
  classifyWorkEventFile,
  countUniqueHiddenRepositoryFiles,
  createHiddenRepositoryPathIdentity,
  groupWorkEventFiles,
  isAutomaticBackupSubject,
  mergeWorkEventChanges,
  selectInferredSessionCommits,
  setWorkEventConfigDirectory,
  shouldRenderWorkEventSearch,
  workEventMetrics
} from "../src/work-events/work-event";

setWorkEventConfigDirectory(".obsidian");
import type { WorkEventCommit, WorkEventFileChange } from "../src/work-events/types";

function commit(
  hash: string,
  parent: string | undefined,
  committedAt: string,
  subject = "auto: 2 个文件"
): WorkEventCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parentHashes: parent ? [parent] : [],
    authorName: "Zoro",
    authorEmail: "zoro@example.com",
    authoredAt: committedAt,
    committedAt,
    subject,
    body: subject
  };
}

function file(overrides: Partial<WorkEventFileChange>): WorkEventFileChange {
  return {
    status: "M",
    repositoryPath: "Notes/A.md",
    vaultPath: "Notes/A.md",
    kind: "markdown",
    addedLines: 1,
    deletedLines: 1,
    binary: false,
    isAnchor: false,
    previewStatus: "ready",
    ...overrides
  };
}

describe("work event classification", () => {
  it("recognizes user notes, Canvas, attachments, and Vault config", () => {
    expect(classifyWorkEventFile("Notes/A.md")).toBe("markdown");
    expect(classifyWorkEventFile("Boards/Plan.canvas")).toBe("canvas");
    expect(classifyWorkEventFile("Attachments/Figure.PNG")).toBe("attachment");
    expect(classifyWorkEventFile(".obsidian/plugins/x/data.json")).toBe("config");
  });

  it("recognizes the user's automatic backup subjects without swallowing manual commits", () => {
    expect(isAutomaticBackupSubject("auto: 14 个文件 · +115/-5")).toBe(true);
    expect(isAutomaticBackupSubject("vault backup: 2026-07-29 21:04:41")).toBe(true);
    expect(isAutomaticBackupSubject("Mac Backup: 2026-06-15 21:50:58")).toBe(true);
    expect(isAutomaticBackupSubject("fix(finance): finish category normalization")).toBe(false);
  });

  it("keeps the file filter visible while a previous query is still active", () => {
    expect(shouldRenderWorkEventSearch(21, "")).toBe(true);
    expect(shouldRenderWorkEventSearch(1, "old query")).toBe(true);
    expect(shouldRenderWorkEventSearch(1, "   ")).toBe(false);
  });
});

describe("inferred Git editing sessions", () => {
  it("groups only continuous first-parent automatic backups by the same author and time window", () => {
    const candidates = [
      commit("cccccccc", "bbbbbbbb", "2026-07-29T21:39:02+09:00"),
      commit("bbbbbbbb", "aaaaaaaa", "2026-07-29T21:35:03+09:00"),
      commit("aaaaaaaa", "99999999", "2026-07-29T21:30:57+09:00"),
      commit("99999999", "88888888", "2026-07-29T20:00:00+09:00")
    ];
    const selected = selectInferredSessionCommits(candidates);
    expect(selected.commits.map((item) => item.hash)).toEqual([
      "cccccccc",
      "bbbbbbbb",
      "aaaaaaaa"
    ]);
    expect(selected.confidence).toBe("heuristic");
  });

  it("keeps manual commits and milestone boundaries exact", () => {
    const manual = commit(
      "cccccccc",
      "bbbbbbbb",
      "2026-07-29T21:39:02+09:00",
      "Update research question"
    );
    const backup = commit("bbbbbbbb", "aaaaaaaa", "2026-07-29T21:35:03+09:00");
    expect(selectInferredSessionCommits([manual, backup]).commits).toHaveLength(1);
    expect(selectInferredSessionCommits(
      [commit("cccccccc", "bbbbbbbb", "2026-07-29T21:39:02+09:00"), backup],
      ["bbbbbbbb"]
    ).commits).toHaveLength(1);
  });
});

describe("work event change aggregation", () => {
  it("deduplicates opaque hidden-file aliases across commit slices without exposing paths", () => {
    const hiddenPathIdentity = createHiddenRepositoryPathIdentity();
    const options = {
      hiddenPathIdentity,
      toVaultPath: () => null
    };
    const first = mergeWorkEventChanges(
      [
        {
          path: "Private/old-name.md",
          changeType: "M",
          addedLines: 1,
          deletedLines: 1
        },
        {
          path: "Private/repeated.json",
          changeType: "M",
          addedLines: 1,
          deletedLines: 1
        }
      ],
      [],
      options
    );
    const second = mergeWorkEventChanges(
      [
        {
          path: "Private/new-name.md",
          originalPath: "Private/old-name.md",
          changeType: "R",
          addedLines: 0,
          deletedLines: 0
        },
        {
          path: "Private/repeated.json",
          changeType: "M",
          addedLines: 1,
          deletedLines: 1
        }
      ],
      [],
      options
    );
    const third = mergeWorkEventChanges(
      [
        {
          path: "Private/new-name.md",
          changeType: "M",
          addedLines: 1,
          deletedLines: 1
        },
        {
          path: "Private/repeated.json",
          changeType: "M",
          addedLines: 1,
          deletedLines: 1
        }
      ],
      [],
      options
    );
    const identityGroups = [first, second, third].flatMap(
      (result) => result.hiddenRepositoryFileIdentityGroups
    );

    expect(first.hiddenRepositoryFileCount).toBe(2);
    expect(second.hiddenRepositoryFileCount).toBe(2);
    expect(third.hiddenRepositoryFileCount).toBe(2);
    expect(countUniqueHiddenRepositoryFiles(identityGroups)).toBe(2);
    expect(identityGroups.flat()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[0-9a-f]{64}$/)
      ])
    );
    expect(JSON.stringify(identityGroups)).not.toContain("Private/");
    expect(JSON.stringify(identityGroups)).not.toContain("old-name");
    expect(JSON.stringify(identityGroups)).not.toContain("repeated");
  });

  it("does not collapse an external copy into its unchanged source file", () => {
    const hiddenPathIdentity = createHiddenRepositoryPathIdentity();
    const options = {
      hiddenPathIdentity,
      toVaultPath: () => null
    };
    const sourceChange = mergeWorkEventChanges(
      [{
        path: "Private/source.md",
        changeType: "M",
        addedLines: 1,
        deletedLines: 1
      }],
      [],
      options
    );
    const copiedFile = mergeWorkEventChanges(
      [{
        path: "Private/copy.md",
        originalPath: "Private/source.md",
        changeType: "C100",
        addedLines: 1,
        deletedLines: 0
      }],
      [],
      options
    );

    expect(countUniqueHiddenRepositoryFiles([
      ...sourceChange.hiddenRepositoryFileIdentityGroups,
      ...copiedFile.hiddenRepositoryFileIdentityGroups
    ])).toBe(2);
  });

  it("merges NUL-safe status and numstat while hiding repository files outside the Vault", () => {
    const merged = mergeWorkEventChanges(
      [
        {
          path: "Vault/Notes/New.md",
          originalPath: "Vault/Notes/Old.md",
          changeType: "R",
          addedLines: 0,
          deletedLines: 0
        },
        {
          path: "README.md",
          changeType: "M",
          addedLines: 0,
          deletedLines: 0
        }
      ],
      [{
        path: "Vault/Notes/New.md",
        originalPath: "Vault/Notes/Old.md",
        addedLines: 3,
        deletedLines: 2,
        binary: false
      }],
      {
        anchorVaultPath: "Notes/New.md",
        toVaultPath: (repositoryPath) =>
          repositoryPath.startsWith("Vault/")
            ? repositoryPath.slice("Vault/".length)
            : null
      }
    );
    expect(merged.hiddenRepositoryFileCount).toBe(1);
    expect(merged.changes[0]).toMatchObject({
      status: "R",
      vaultPath: "Notes/New.md",
      originalVaultPath: "Notes/Old.md",
      addedLines: 3,
      deletedLines: 2,
      isAnchor: true
    });
  });

  it("never exposes or reads the repository side of a rename crossing the Vault boundary", () => {
    const intoVault = mergeWorkEventChanges(
      [{
        path: "Vault/Notes/In.md",
        originalPath: "Private/Outside.md",
        changeType: "R",
        addedLines: 0,
        deletedLines: 0
      }],
      [],
      {
        toVaultPath: (repositoryPath) =>
          repositoryPath.startsWith("Vault/")
            ? repositoryPath.slice("Vault/".length)
            : null
      }
    ).changes[0]!;
    const outOfVault = mergeWorkEventChanges(
      [{
        path: "Private/Outside.md",
        originalPath: "Vault/Notes/Out.md",
        changeType: "R",
        addedLines: 0,
        deletedLines: 0
      }],
      [],
      {
        toVaultPath: (repositoryPath) =>
          repositoryPath.startsWith("Vault/")
            ? repositoryPath.slice("Vault/".length)
            : null
      }
    ).changes[0]!;

    expect(intoVault).toMatchObject({
      status: "A",
      repositoryPath: "Vault/Notes/In.md",
      vaultPath: "Notes/In.md"
    });
    expect(intoVault.originalRepositoryPath).toBeUndefined();
    expect(outOfVault).toMatchObject({
      status: "D",
      repositoryPath: "Vault/Notes/Out.md",
      vaultPath: "Notes/Out.md"
    });
    expect(outOfVault.originalRepositoryPath).toBeUndefined();
    expect(JSON.stringify([intoVault, outOfVault])).not.toContain("Private/");

    const copiedOut = mergeWorkEventChanges(
      [{
        path: "Private/Copy.md",
        originalPath: "Vault/Notes/Source.md",
        changeType: "C",
        addedLines: 0,
        deletedLines: 0
      }],
      [],
      {
        toVaultPath: (repositoryPath) =>
          repositoryPath.startsWith("Vault/")
            ? repositoryPath.slice("Vault/".length)
            : null
      }
    );
    expect(copiedOut.changes).toEqual([]);
    expect(copiedOut.hiddenRepositoryFileCount).toBe(1);
  });

  it("uses the historical repository path to keep a renamed anchor in the current-note group", () => {
    const merged = mergeWorkEventChanges(
      [{
        path: "Vault/Old/Anchor.md",
        changeType: "M",
        addedLines: 1,
        deletedLines: 1
      }],
      [],
      {
        anchorVaultPath: "New/Anchor.md",
        anchorRepositoryPath: "Vault/Old/Anchor.md",
        toVaultPath: (repositoryPath) => repositoryPath.slice("Vault/".length)
      }
    );
    expect(merged.changes[0]?.isAnchor).toBe(true);
  });

  it("groups the current note first and reports stable metrics", () => {
    const files = [
      file({ vaultPath: "Notes/Current.md", isAnchor: true }),
      file({ vaultPath: "Notes/Deleted.md", status: "D" }),
      file({ vaultPath: "Files/Figure.png", repositoryPath: "Files/Figure.png", kind: "attachment", binary: true }),
      file({ vaultPath: ".obsidian/app.json", repositoryPath: ".obsidian/app.json", kind: "config" })
    ];
    expect(groupWorkEventFiles(files).map((group) => group.key)).toEqual([
      "current",
      "attention",
      "attachments",
      "technical"
    ]);
    expect(workEventMetrics(files, 2)).toMatchObject({
      files: 4,
      notes: 2,
      attachments: 1,
      deletedFiles: 1,
      addedLines: 4,
      deletedLines: 4,
      relationChanges: 2
    });
  });
});
