import { describe, expect, it } from "vitest";
import type {
  FileReviewState,
  GitCommitVersion
} from "../src/models";
import {
  buildProvenanceLensAnalysis,
  citationSynchronizationRisks,
  classifyCommitSource,
  parseLinePorcelain,
  parseMarkdownBlocks
} from "../src/provenance/provenance-lens";

function commit(
  hash: string,
  overrides: Partial<GitCommitVersion> = {}
): GitCommitVersion {
  return {
    hash,
    shortHash: hash.slice(0, 8),
    authorName: "Writer",
    authorEmail: "writer@example.com",
    authoredAt: "2026-07-30T01:00:00.000Z",
    subject: "Edit note",
    historicalPath: "Note.md",
    changeType: "M",
    addedLines: 1,
    deletedLines: 1,
    trailers: {},
    ...overrides
  };
}

function state(commitHash?: string, workingFingerprint?: string): FileReviewState {
  return {
    bookmarks: {},
    milestones: {},
    ...(commitHash
      ? {
          reviewCheckpoint: {
            commitHash,
            historicalPath: "Note.md",
            reviewedAt: "2026-07-30T02:00:00.000Z",
            ...(workingFingerprint ? { workingFingerprint } : {})
          }
        }
      : {})
  };
}

describe("provenance lens", () => {
  it("parses line porcelain and inherits omitted commit metadata", () => {
    const hash = "a".repeat(40);
    const parsed = parseLinePorcelain([
      `${hash} 1 1 2`,
      "author Human",
      "author-mail <human@example.com>",
      "author-time 1785373200",
      "summary Initial",
      "filename Note.md",
      "\tFirst",
      `${hash} 2 2`,
      "\tSecond"
    ].join("\n"));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      line: 1,
      hash,
      content: "First",
      authorName: "Human",
      authorEmail: "human@example.com",
      working: false
    });
    expect(parsed[1]).toMatchObject({
      line: 2,
      content: "Second",
      authorName: "Human"
    });
  });

  it("preserves frontmatter, heading paths, fenced blank lines, and line ranges", () => {
    const blocks = parseMarkdownBlocks([
      "---",
      "status: draft",
      "---",
      "",
      "# Result",
      "",
      "The result changed.",
      "",
      "```ts",
      "const value = 1;",
      "",
      "return value;",
      "```"
    ].join("\n"));
    expect(blocks.map((block) => [block.kind, block.startLine, block.endLine])).toEqual([
      ["frontmatter", 1, 3],
      ["heading", 5, 5],
      ["paragraph", 7, 7],
      ["code", 9, 13]
    ]);
    expect(blocks[2]?.headingPath).toBe("Result");
  });

  it("classifies trailers before heuristic identities without judging correctness", () => {
    const agent = commit("a".repeat(40), {
      trailers: {
        agent: "local-agent",
        authority: "draft",
        "send-gate": "user_review_not_sent"
      }
    });
    const automated = commit("b".repeat(40), {
      subject: "auto backup: Note"
    });
    expect(classifyCommitSource(agent).kind).toBe("agent");
    expect(classifyCommitSource(agent).label).toBe("local-agent");
    expect(classifyCommitSource(automated).kind).toBe("automation");
  });

  it("flags changed claims whose existing citations did not change", () => {
    const previous = parseMarkdownBlocks(
      "# Result\n\nThe effect is small [[Paper A]]."
    );
    const current = parseMarkdownBlocks(
      "# Result\n\nThe effect is large [[Paper A]]."
    );
    const risks = citationSynchronizationRisks(current, previous);
    expect([...risks]).toEqual([current[1]?.id]);

    const changedCitation = parseMarkdownBlocks(
      "# Result\n\nThe effect is large [[Paper B]]."
    );
    expect(citationSynchronizationRisks(changedCitation, previous).size).toBe(0);
  });

  it("marks Agent and working blocks pending until the checkpoint covers them", () => {
    const agentHash = "a".repeat(40);
    const reviewHash = "b".repeat(40);
    const content = "# Result\n\nAgent claim [[Paper]].\n\nWorking sentence.";
    const blame = [
      {
        line: 1,
        hash: reviewHash,
        content: "# Result",
        authorName: "Reviewer",
        authorEmail: "reviewer@example.com",
        authoredAt: "2026-07-30T02:00:00.000Z",
        working: false
      },
      {
        line: 3,
        hash: agentHash,
        content: "Agent claim [[Paper]].",
        authorName: "Agent",
        authorEmail: "agent@example.com",
        authoredAt: "2026-07-30T01:00:00.000Z",
        working: false
      },
      {
        line: 5,
        hash: "0".repeat(40),
        content: "Working sentence.",
        authorName: "",
        authorEmail: "",
        authoredAt: "",
        working: true
      }
    ];
    const commits = [
      commit(reviewHash, {
        authorName: "Reviewer",
        authoredAt: "2026-07-30T02:00:00.000Z"
      }),
      commit(agentHash, {
        authorName: "Agent",
        authoredAt: "2026-07-30T01:00:00.000Z",
        trailers: { agent: "research-agent" }
      })
    ];
    const pending = buildProvenanceLensAnalysis({
      content,
      blame,
      commits,
      reviewState: state()
    });
    expect(pending.summary.agentBlocks).toBe(1);
    expect(pending.summary.workingBlocks).toBe(1);
    expect(pending.summary.needsReview).toBe(2);

    const reviewed = buildProvenanceLensAnalysis({
      content,
      blame,
      commits,
      reviewState: state(
        reviewHash,
        pending.workingFingerprint
      )
    });
    expect(reviewed.summary.needsReview).toBe(0);
  });

  it("keeps absent blame explicit as unknown rather than inventing a human source", () => {
    const analysis = buildProvenanceLensAnalysis({
      content: "# Empty provenance",
      blame: [],
      commits: [],
      reviewState: state()
    });
    expect(analysis.blocks[0]?.primarySource.kind).toBe("unknown");
    expect(analysis.summary.unknownBlocks).toBe(1);
    expect(classifyCommitSource(undefined, {
      line: 1,
      hash: "c".repeat(40),
      content: "Old line",
      authorName: "Named author",
      authorEmail: "named@example.com",
      authoredAt: "2026-01-01T00:00:00.000Z",
      working: false
    }).kind).toBe("unknown");
  });
});
