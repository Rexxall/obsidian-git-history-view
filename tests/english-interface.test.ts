import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLanguage: () => "en"
}));

const { buildHealthDiagnostics } = await import("../src/health/history-health");
const { tr } = await import("../src/i18n");

const commit = {
  hash: "a".repeat(40),
  shortHash: "aaaaaaa",
  authorName: "Test",
  authorEmail: "test@example.com",
  authoredAt: "2026-07-30T00:00:00.000Z",
  subject: "Update",
  historicalPath: "Note.md",
  changeType: "M" as const,
  addedLines: 1,
  deletedLines: 1,
  trailers: {}
};
const context = { vaultRoot: "/repo", repositoryRoot: "/repo", repositoryRelativePath: "Note.md" };

describe("English interface", () => {
  it("follows Obsidian's language", () => {
    expect(tr("历史健康中心", "History health")).toBe("History health");
  });

  it("writes lab diagnostics without Chinese", () => {
    const diagnostics = buildHealthDiagnostics({
      context,
      history: {
        context,
        branch: "main",
        status: { raw: "", staged: false, unstaged: false, untracked: false, conflicted: false },
        commits: [commit],
        hasMoreHistory: true,
        workingTreeStats: { addedLines: 0, deletedLines: 0 }
      },
      headHash: commit.hash,
      upstream: "origin/main",
      ahead: 2,
      behind: 0,
      shallow: true,
      partialClone: true,
      objectFormat: "sha1",
      missingObjects: ["?abc"],
      ignoreRevs: [],
      ignoreRevsConfigured: false,
      currentLfsPointer: true
    } as Parameters<typeof buildHealthDiagnostics>[0], 3);
    const text = JSON.stringify(diagnostics);
    expect(diagnostics.length).toBeGreaterThan(4);
    expect(text).not.toMatch(/[㐀-鿿]/);
  });
});
