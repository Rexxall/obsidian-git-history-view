import { describe, expect, it } from "vitest";
import {
  annotationBlockAnchor,
  buildMarkdownReviewPackage,
  decodeGitNotesReview,
  encodeGitNotesReview,
  locateReviewAnnotation,
  normalizeReviewAnnotations
} from "../src/annotations/review-annotations";
import { extractMarkdownBlocks } from "../src/history/markdown-blocks";
import type { ReviewAnnotation } from "../src/annotations/types";

function annotation(overrides: Partial<ReviewAnnotation> = {}): ReviewAnnotation {
  const block = extractMarkdownBlocks("# 标题\n\n原始段落")[1]!;
  return {
    id: "annotation-1",
    repositoryRoot: "/repo",
    filePath: "Notes/A.md",
    historicalPath: "Old/A.md",
    commitHash: "a".repeat(40),
    versionLabel: "旧版本",
    target: "block",
    block: annotationBlockAnchor(block),
    comment: "这里需要补充证据。",
    status: "pending",
    source: "local",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides
  };
}

describe("review annotations", () => {
  it("relocates an exact block after surrounding content moves", () => {
    const item = annotation();
    const located = locateReviewAnnotation(item, "# 新标题\n\n前文\n\n原始段落\n\n后文");
    expect(located.unresolved).toBe(false);
    expect(located.relocated).toBe(true);
    expect(located.currentBlock?.startLine).toBe(4);
  });

  it("keeps original context when a block can no longer be located", () => {
    const item = annotation();
    const located = locateReviewAnnotation(item, "# 完全不同\n\n没有相关内容");
    expect(located.unresolved).toBe(true);
    expect(located.annotation.block?.originalContent).toBe("原始段落");
  });

  it("preserves unrelated Git note text while replacing managed data", () => {
    const first = encodeGitNotesReview("团队已有说明", [annotation()]);
    const second = encodeGitNotesReview(first, [
      annotation({ comment: "已经更新", status: "resolved" })
    ]);
    expect(second).toContain("团队已有说明");
    expect(second.match(/git-note-history:begin/g)).toHaveLength(1);
    expect(decodeGitNotesReview(second)[0]?.comment).toBe("已经更新");
  });

  it("exports a readable Markdown review package", () => {
    const output = buildMarkdownReviewPackage("Notes/A.md", [annotation()]);
    expect(output).toContain("# Notes/A.md · 版本审阅");
    expect(output).toContain("待处理");
    expect(output).toContain("这里需要补充证据");
    expect(output).toContain("```markdown\n原始段落");
  });

  it("drops invalid persisted records", () => {
    const valid = annotation();
    expect(normalizeReviewAnnotations({
      [valid.id]: valid,
      broken: { id: "broken" }
    })).toEqual({ [valid.id]: valid });
  });
});
