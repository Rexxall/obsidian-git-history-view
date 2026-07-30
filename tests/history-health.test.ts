import { describe, expect, it } from "vitest";
import type { GitCommitVersion } from "../src/models";
import {
  analyzeHistoryHealth,
  buildHealthDiagnostics,
  classifyHistorySignal,
  normalizeSignalRules
} from "../src/health/history-health";
import type { GitHistoryHealthSnapshot } from "../src/health/types";

function commit(hash = "a".repeat(40)): GitCommitVersion {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    authorName: "Test",
    authorEmail: "test@example.com",
    authoredAt: "2026-07-30T00:00:00.000Z",
    subject: "Update",
    historicalPath: "Note.md",
    changeType: "M",
    addedLines: 1,
    deletedLines: 1,
    trailers: {}
  };
}

function snapshot(overrides: Partial<GitHistoryHealthSnapshot> = {}): GitHistoryHealthSnapshot {
  const item = commit();
  return {
    context: {
      vaultRoot: "/repo",
      repositoryRoot: "/repo",
      repositoryRelativePath: "Note.md"
    },
    history: {
      context: {
        vaultRoot: "/repo",
        repositoryRoot: "/repo",
        repositoryRelativePath: "Note.md"
      },
      branch: "main",
      status: {
        raw: "",
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false
      },
      commits: [item],
      hasMoreHistory: false,
      workingTreeStats: { addedLines: 0, deletedLines: 0 }
    },
    headHash: item.hash,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    shallow: false,
    partialClone: false,
    objectFormat: "sha1",
    missingObjects: [],
    ignoreRevs: [],
    ignoreRevsConfigured: false,
    currentLfsPointer: false,
    ...overrides
  };
}

describe("history signal classification", () => {
  it("classifies timestamp-only changes as metadata noise", () => {
    const entry = classifyHistorySignal(
      commit(),
      "---\ntitle: A\nupdated: old\n---\nBody\n",
      "---\nupdated: new\ntitle: A\n---\nBody\n",
      normalizeSignalRules(undefined)
    );
    expect(entry.kind).toBe("metadata");
    expect(entry.hiddenByProfile).toBe(true);
    expect(entry.matchedFields).toContain("updated");
  });

  it("separates generated fields from ordinary ignored properties", () => {
    const entry = classifyHistorySignal(
      commit(),
      "---\ntitle: A\nchecksum: old\n---\nBody",
      "---\ntitle: A\nchecksum: new\n---\nBody",
      normalizeSignalRules(undefined)
    );
    expect(entry.kind).toBe("generated");
  });

  it("recognizes property ordering and line-ending-only changes", () => {
    const entry = classifyHistorySignal(
      commit(),
      "---\r\ntitle: A\r\nstatus: draft\r\n---\r\nBody  \r\n",
      "---\nstatus: draft\ntitle: A\n---\nBody\n",
      normalizeSignalRules(undefined)
    );
    expect(entry.kind).toBe("formatting");
  });

  it("never hides substantive content changes", () => {
    const entry = classifyHistorySignal(
      commit(),
      "---\nupdated: old\n---\nOriginal claim",
      "---\nupdated: new\n---\nChanged claim",
      normalizeSignalRules(undefined)
    );
    expect(entry.kind).toBe("content");
    expect(entry.hiddenByProfile).toBe(false);
  });

  it("does not hide changed YAML comments beside ignored properties", () => {
    const entry = classifyHistorySignal(
      commit(),
      "---\nupdated: old\n# verify with source A\n---\nBody",
      "---\nupdated: new\n# verify with source B\n---\nBody",
      normalizeSignalRules(undefined)
    );
    expect(entry.kind).toBe("content");
  });

  it("uses ignore-revs only when enabled and keeps raw mode visible", () => {
    const item = commit();
    const ignored = new Set([item.hash]);
    expect(classifyHistorySignal(item, "a", "b", {
      ...normalizeSignalRules(undefined),
      profile: "balanced"
    }, ignored).kind).toBe("ignored-revision");
    expect(classifyHistorySignal(item, "a", "b", {
      ...normalizeSignalRules(undefined),
      profile: "raw"
    }, ignored).hiddenByProfile).toBe(false);
  });
});

describe("history health diagnostics", () => {
  it("reports shallow, missing, LFS, local-only, and read-window risks separately", () => {
    const diagnostics = buildHealthDiagnostics(snapshot({
      shallow: true,
      missingObjects: ["?abc"],
      currentLfsPointer: true,
      upstream: "origin/main",
      ahead: 2,
      history: {
        ...snapshot().history,
        hasMoreHistory: true
      }
    }), 3);
    expect(diagnostics.map((item) => item.id)).toEqual(expect.arrayContaining([
      "missing-objects",
      "shallow",
      "read-limit",
      "lfs-pointer",
      "ahead",
      "local-snapshots"
    ]));
  });

  it("does not turn unreadable versions into noise", () => {
    const source = snapshot();
    const result = analyzeHistoryHealth({
      snapshot: source,
      contents: new Map(),
      rules: normalizeSignalRules(undefined),
      localSnapshotCount: 0
    });
    expect(result.unknownCount).toBe(1);
    expect(result.noiseCount).toBe(0);
  });

  it("keeps the oldest loaded commit unknown when earlier history is truncated", () => {
    const source = snapshot({
      history: {
        ...snapshot().history,
        hasMoreHistory: true
      }
    });
    const result = analyzeHistoryHealth({
      snapshot: source,
      contents: new Map([[source.history.commits[0]!.hash, "# Current"]]),
      localSnapshotCount: 0
    });
    expect(result.entries[0]?.kind).toBe("unknown");
  });
});
