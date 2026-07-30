import { describe, expect, it } from "vitest";
import { evaluateKnowledgeAssertion } from "../src/knowledge-trace/assertion-evaluator";
import { traceKnowledgeBoundary } from "../src/knowledge-trace/boundary-search";
import type {
  KnowledgeTraceVersion,
  TextKnowledgeAssertion
} from "../src/knowledge-trace/types";

const containsTarget: TextKnowledgeAssertion = {
  kind: "text",
  operator: "contains",
  expected: "verified claim"
};

function versions(...contents: Array<string | undefined>): KnowledgeTraceVersion[] {
  return contents.map((content, index) => {
    const base = {
      key: `v${index}`,
      label: `Version ${index}`
    };
    return content === undefined
      ? { ...base, unavailableReason: "读取上限" }
      : { ...base, content };
  });
}

describe("knowledge assertion evaluator", () => {
  it("supports contains, not-contains, and whole-content equality", () => {
    const version = { key: "current", content: "Alpha\nverified claim\nOmega" };

    expect(evaluateKnowledgeAssertion(containsTarget, version).outcome).toBe("holds");
    expect(evaluateKnowledgeAssertion({
      ...containsTarget,
      operator: "not-contains"
    }, version).outcome).toBe("does-not-hold");
    expect(evaluateKnowledgeAssertion({
      ...containsTarget,
      operator: "equals",
      expected: version.content
    }, version).outcome).toBe("holds");
    expect(evaluateKnowledgeAssertion({
      ...containsTarget,
      operator: "equals",
      expected: "verified claim"
    }, version).outcome).toBe("does-not-hold");
  });

  it("can ignore case and normalize line endings without weakening exact mode by default", () => {
    const version = { key: "v1", content: "Claim\r\nREADY" };

    expect(evaluateKnowledgeAssertion({
      kind: "text",
      operator: "contains",
      expected: "ready",
      caseSensitive: false
    }, version).outcome).toBe("holds");
    expect(evaluateKnowledgeAssertion({
      kind: "text",
      operator: "equals",
      expected: "Claim\nREADY"
    }, version).outcome).toBe("does-not-hold");
    expect(evaluateKnowledgeAssertion({
      kind: "text",
      operator: "equals",
      expected: "Claim\nREADY",
      normalizeLineEndings: true
    }, version).outcome).toBe("holds");
  });

  it("keeps unavailable content unknown", () => {
    expect(evaluateKnowledgeAssertion(
      containsTarget,
      { key: "large", unavailableReason: "文件过大" }
    )).toMatchObject({
      outcome: "unknown",
      reason: "content-unavailable",
      detail: "文件过大",
      provenance: "automatic"
    });
  });
});

describe("typed YAML property assertions", () => {
  const typedFrontmatter = [
    "---",
    "status: Verified",
    "stringNumber: \"1\"",
    "count: 1",
    "enabled: true",
    "empty: null",
    "tags: [research, 2]",
    "meta: {owner: Bobo, active: true}",
    "---",
    "Body"
  ].join("\n");

  const property = (
    name: string,
    operator: "exists" | "missing" | "equals" | "contains",
    expected?: unknown
  ) => evaluateKnowledgeAssertion(
    expected === undefined
      ? { kind: "property", property: name, operator }
      : { kind: "property", property: name, operator, expected },
    { key: "typed", content: typedFrontmatter }
  );

  it("supports exists and missing without confusing a null value with absence", () => {
    expect(property("empty", "exists").outcome).toBe("holds");
    expect(property("missing", "missing").outcome).toBe("holds");
    expect(property("missing", "exists").outcome).toBe("does-not-hold");
    expect(property("empty", "equals", null)).toMatchObject({
      outcome: "holds",
      provenance: "automatic"
    });
  });

  it("compares string, number, boolean, null, list, and object values by type", () => {
    expect(property("stringNumber", "equals", "1").outcome).toBe("holds");
    expect(property("stringNumber", "equals", 1).outcome).toBe("does-not-hold");
    expect(property("count", "equals", 1).outcome).toBe("holds");
    expect(property("count", "equals", "1").outcome).toBe("does-not-hold");
    expect(property("enabled", "equals", true).outcome).toBe("holds");
    expect(property("enabled", "equals", "true").outcome).toBe("does-not-hold");
    expect(property("tags", "equals", ["research", 2]).outcome).toBe("holds");
    expect(property("tags", "equals", ["2", "research"]).outcome).toBe(
      "does-not-hold"
    );
    expect(property("meta", "equals", {
      active: true,
      owner: "Bobo"
    }).outcome).toBe("holds");
  });

  it("uses typed containment for strings, lists, and object subsets", () => {
    expect(property("status", "contains", "rifi").outcome).toBe("holds");
    expect(evaluateKnowledgeAssertion({
      kind: "property",
      property: "status",
      operator: "contains",
      expected: "verified",
      caseSensitive: false
    }, { key: "typed", content: typedFrontmatter }).outcome).toBe("holds");
    expect(property("tags", "contains", 2).outcome).toBe("holds");
    expect(property("tags", "contains", "2").outcome).toBe("does-not-hold");
    expect(property("meta", "contains", { active: true }).outcome).toBe("holds");
    expect(property("meta", "contains", { active: "true" }).outcome).toBe(
      "does-not-hold"
    );
  });

  it("keeps malformed YAML and malformed assertions unknown", () => {
    expect(evaluateKnowledgeAssertion({
      kind: "property",
      property: "status",
      operator: "equals",
      expected: "draft"
    }, { key: "bad", content: "---\nstatus: [draft\n---\n" })).toMatchObject({
      outcome: "unknown",
      reason: "invalid-frontmatter",
      provenance: "automatic"
    });
    expect(evaluateKnowledgeAssertion({
      kind: "property",
      property: "status",
      operator: "equals"
    }, { key: "typed", content: typedFrontmatter })).toMatchObject({
      outcome: "unknown",
      reason: "invalid-assertion"
    });
  });

  it("keeps property evidence bounded even for very large frontmatter", () => {
    const content = `---\ntranscript: ${"x".repeat(20_000)}\nstatus: ready\n---\nBody`;
    const evaluation = evaluateKnowledgeAssertion({
      kind: "property",
      property: "transcript",
      operator: "exists"
    }, { key: "large-property", content });

    expect(evaluation.outcome).toBe("holds");
    expect(evaluation.evidence?.excerpt.length).toBeLessThanOrEqual(420);
  });
});

describe("relation, Markdown structure, and rule assertions", () => {
  const structuredNote = [
    "# Research plan",
    "",
    "Read [[Paper A#Method|method]] and [local note](Notes/B.md).",
    "![[Figure.png]]",
    "Tag #research/method",
    "",
    "- [ ] Review evidence",
    "",
    "> [!warning] Check source",
    "> Details",
    "",
    "| Claim | State |",
    "| --- | --- |",
    "| A | draft |",
    "",
    "$$x^2 + y^2$$",
    "",
    "Inline $z = 1$.",
    "",
    "```ts",
    "# Not a real heading",
    "- [ ] Not a real task",
    "```"
  ].join("\n");

  it("normalizes wikilinks, Markdown links, embeds, and tags", () => {
    for (const assertion of [
      { relation: "wikilink", target: "Paper A" },
      { relation: "markdown-link", target: "Notes/B.md" },
      { relation: "embed", target: "Figure.png" },
      { relation: "tag", target: "#research/method" }
    ] as const) {
      expect(evaluateKnowledgeAssertion({
        kind: "relation",
        operator: "exists",
        ...assertion
      }, { key: assertion.relation, content: structuredNote })).toMatchObject({
        outcome: "holds",
        provenance: "automatic",
        evidence: expect.objectContaining({ excerpt: expect.any(String) })
      });
    }
    expect(evaluateKnowledgeAssertion({
      kind: "relation",
      relation: "wikilink",
      operator: "missing",
      target: "Unknown note"
    }, { key: "missing", content: structuredNote }).outcome).toBe("holds");
  });

  it("does not treat code examples or HTML comments as note relations", () => {
    const literals = [
      "`[[Inline example]]`",
      "<!-- [[Commented note]] #commented -->",
      "```md",
      "[[Fenced note]]",
      "#fenced",
      "```",
      "[[Real note]]"
    ].join("\n");
    for (const target of ["Inline example", "Commented note", "Fenced note"]) {
      expect(evaluateKnowledgeAssertion({
        kind: "relation",
        relation: "wikilink",
        operator: "missing",
        target
      }, { key: target, content: literals }).outcome).toBe("holds");
    }
    for (const target of ["commented", "fenced"]) {
      expect(evaluateKnowledgeAssertion({
        kind: "relation",
        relation: "tag",
        operator: "missing",
        target
      }, { key: target, content: literals }).outcome).toBe("holds");
    }
    expect(evaluateKnowledgeAssertion({
      kind: "relation",
      relation: "wikilink",
      operator: "exists",
      target: "Real note"
    }, { key: "real", content: literals }).outcome).toBe("holds");
  });

  it("finds deterministic structures while ignoring examples inside code fences", () => {
    for (const assertion of [
      { structure: "heading", value: "Research plan" },
      { structure: "task", value: "Review evidence" },
      { structure: "code-block", value: "ts" },
      { structure: "callout", value: "WARNING" },
      { structure: "table", value: "Claim | State" },
      { structure: "formula", value: "x^2 + y^2" },
      { structure: "formula", value: "z = 1" }
    ] as const) {
      expect(evaluateKnowledgeAssertion({
        kind: "structure",
        operator: "exists",
        ...assertion
      }, { key: assertion.structure, content: structuredNote })).toMatchObject({
        outcome: "holds",
        evidence: expect.objectContaining({ excerpt: expect.any(String) })
      });
    }
    expect(evaluateKnowledgeAssertion({
      kind: "structure",
      structure: "heading",
      operator: "missing",
      value: "Not a real heading"
    }, { key: "fenced", content: structuredNote }).outcome).toBe("holds");
  });

  it("ignores multiline HTML comments and formulas inside inline code without shifting evidence", () => {
    const content = [
      "前缀😀",
      "<!--",
      "隐藏😀",
      "# Hidden heading",
      "- [ ] Hidden task",
      "| Hidden | State |",
      "| --- | --- |",
      "$$hidden = 1$$",
      "-->",
      "`$inline = 1$` and ``$also_inline = 2$``",
      "Visible 😀 $x = 3$",
      "```md",
      "# Still fenced",
      "```"
    ].join("\n");

    for (const assertion of [
      { structure: "heading", value: "Hidden heading" },
      { structure: "task", value: "Hidden task" },
      { structure: "table", value: "Hidden | State" },
      { structure: "formula", value: "hidden = 1" },
      { structure: "formula", value: "inline = 1" },
      { structure: "formula", value: "also_inline = 2" }
    ] as const) {
      expect(evaluateKnowledgeAssertion({
        kind: "structure",
        operator: "missing",
        ...assertion
      }, { key: assertion.structure, content }).outcome).toBe("holds");
    }

    const visibleFormula = evaluateKnowledgeAssertion({
      kind: "structure",
      structure: "formula",
      operator: "exists",
      value: "x = 3"
    }, { key: "visible-formula", content });
    const formulaStart = content.indexOf("$x = 3$");
    expect(visibleFormula).toMatchObject({
      outcome: "holds",
      evidence: {
        start: formulaStart,
        end: formulaStart + "$x = 3$".length,
        excerpt: "$x = 3$"
      }
    });

    expect(evaluateKnowledgeAssertion({
      kind: "structure",
      structure: "code-block",
      operator: "exists",
      value: "md"
    }, { key: "fenced-code", content }).outcome).toBe("holds");
  });

  it("does not let comment-like text inside a fence hide later Markdown", () => {
    const content = [
      "```md",
      "<!-- deliberately unclosed inside the example",
      "# Fenced heading",
      "```",
      "# Real heading",
      "Visible $after = 1$"
    ].join("\n");

    expect(evaluateKnowledgeAssertion({
      kind: "structure",
      structure: "heading",
      operator: "exists",
      value: "Real heading"
    }, { key: "after-fence-heading", content }).outcome).toBe("holds");
    expect(evaluateKnowledgeAssertion({
      kind: "structure",
      structure: "formula",
      operator: "exists",
      value: "after = 1"
    }, { key: "after-fence-formula", content }).outcome).toBe("holds");
    expect(evaluateKnowledgeAssertion({
      kind: "structure",
      structure: "heading",
      operator: "missing",
      value: "Fenced heading"
    }, { key: "inside-fence", content }).outcome).toBe("holds");
  });

  it("ignores formulas inside code spans that cross line boundaries", () => {
    const content = [
      "Before ``code starts",
      "$hidden = 1$",
      "code ends``",
      "Visible 😀 $shown = 2$"
    ].join("\n");

    expect(evaluateKnowledgeAssertion({
      kind: "structure",
      structure: "formula",
      operator: "missing",
      value: "hidden = 1"
    }, { key: "multiline-code-hidden", content }).outcome).toBe("holds");

    const visible = evaluateKnowledgeAssertion({
      kind: "structure",
      structure: "formula",
      operator: "exists",
      value: "shown = 2"
    }, { key: "multiline-code-visible", content });
    const start = content.indexOf("$shown = 2$");
    expect(visible).toMatchObject({
      outcome: "holds",
      evidence: {
        start,
        end: start + "$shown = 2$".length,
        excerpt: "$shown = 2$"
      }
    });
  });

  it("explains conflict, frontmatter, and nonempty-body rule failures", () => {
    const conflict = evaluateKnowledgeAssertion({
      kind: "rule",
      ruleId: "no-conflict-markers"
    }, {
      key: "conflict",
      content: "<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> branch\n"
    });
    expect(conflict).toMatchObject({
      outcome: "does-not-hold",
      detail: expect.stringContaining("冲突"),
      evidence: expect.objectContaining({ excerpt: expect.stringContaining("<<<<<<<") })
    });

    expect(evaluateKnowledgeAssertion({
      kind: "rule",
      ruleId: "valid-frontmatter"
    }, { key: "valid", content: "---\ncount: 1\n---\n" }).outcome).toBe("holds");
    expect(evaluateKnowledgeAssertion({
      kind: "rule",
      ruleId: "valid-frontmatter"
    }, { key: "invalid", content: "---\ncount: [1\n---\n" })).toMatchObject({
      outcome: "does-not-hold",
      detail: expect.stringContaining("Frontmatter 无效")
    });
    expect(evaluateKnowledgeAssertion({
      kind: "rule",
      ruleId: "nonempty-body"
    }, { key: "empty", content: "---\ncount: 1\n---\n \n" }).outcome).toBe(
      "does-not-hold"
    );
    expect(evaluateKnowledgeAssertion({
      kind: "rule",
      ruleId: "nonempty-body"
    }, { key: "body", content: "---\ncount: 1\n---\n# Body\n" }).outcome).toBe(
      "holds"
    );
    expect(evaluateKnowledgeAssertion({
      kind: "rule",
      ruleId: "unknown-rule"
    }, { key: "unknown", content: "# Body" })).toMatchObject({
      outcome: "unknown",
      reason: "unsupported-assertion"
    });
  });
});

describe("manual assertions", () => {
  it("reads explicit per-version judgments and never presents them as automatic", () => {
    expect(evaluateKnowledgeAssertion({
      kind: "manual",
      prompt: "这版结论仍正确吗？"
    }, {
      key: "judged",
      content: "Frozen version",
      manualOutcome: "holds",
      manualDetail: "人工核对来源后判定"
    })).toMatchObject({
      outcome: "holds",
      provenance: "manual",
      detail: "人工核对来源后判定"
    });
    expect(evaluateKnowledgeAssertion({
      kind: "manual",
      prompt: "这版结论仍正确吗？"
    }, { key: "pending", content: "Frozen version" })).toMatchObject({
      outcome: "unknown",
      reason: "manual-unjudged",
      provenance: "manual"
    });
    expect(evaluateKnowledgeAssertion({
      kind: "manual",
      prompt: "这版结论仍正确吗？"
    }, {
      key: "unreadable",
      manualOutcome: "holds",
      unavailableReason: "对象缺失"
    })).toMatchObject({
      outcome: "unknown",
      reason: "content-unavailable",
      provenance: "manual",
      detail: "对象缺失"
    });
  });

  it("returns a manual candidate rather than an automatically confirmed boundary", () => {
    const result = traceKnowledgeBoundary({
      assertion: {
        kind: "manual",
        prompt: "这版结论仍正确吗？"
      },
      versions: [
        { key: "old", content: "Old", manualOutcome: "does-not-hold" },
        { key: "new", content: "New", manualOutcome: "holds" }
      ]
    });

    expect(result).toMatchObject({
      conclusion: "manual-candidate",
      confirmed: false,
      boundary: null,
      verificationMode: "manual",
      transitions: [{
        beforeVersionKey: "old",
        afterVersionKey: "new"
      }]
    });
  });
});

describe("knowledge boundary trace", () => {
  it("probes a binary candidate before verifying every version oldest-to-newest", () => {
    const result = traceKnowledgeBoundary({
      assertion: containsTarget,
      versions: versions(
        "draft 0",
        "draft 1",
        "draft 2",
        "draft 3",
        "verified claim 4",
        "verified claim 5",
        "verified claim 6",
        "verified claim 7"
      )
    });

    expect(result).toMatchObject({
      conclusion: "confirmed",
      confirmed: true,
      candidate: {
        beforeIndex: 3,
        afterIndex: 4,
        from: "does-not-hold",
        to: "holds"
      },
      boundary: {
        beforeVersionKey: "v3",
        afterVersionKey: "v4"
      },
      unknownIndices: []
    });
    expect(
      result.probeOrder
        .filter((probe) => probe.phase === "binary")
        .map((probe) => probe.index)
    ).toEqual([0, 7, 3, 5, 4]);
    expect(
      result.probeOrder
        .filter((probe) => probe.phase === "verification")
        .map((probe) => probe.index)
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(
      result.probeOrder
        .filter((probe) => probe.phase === "verification" && probe.cached)
        .map((probe) => probe.index)
    ).toEqual([0, 3, 4, 5, 7]);
  });

  it("confirms a unique reverse transition as well as an appearance", () => {
    const result = traceKnowledgeBoundary({
      assertion: containsTarget,
      versions: versions(
        "verified claim",
        "verified claim",
        "removed",
        "removed"
      )
    });

    expect(result.conclusion).toBe("confirmed");
    expect(result.boundary).toMatchObject({
      beforeIndex: 1,
      afterIndex: 2,
      from: "holds",
      to: "does-not-hold"
    });
  });

  it("reports repeated appearance and deletion instead of confirming one boundary", () => {
    const result = traceKnowledgeBoundary({
      assertion: containsTarget,
      versions: versions(
        "absent",
        "verified claim",
        "verified claim",
        "absent",
        "absent"
      )
    });

    expect(result).toMatchObject({
      conclusion: "repeated-change",
      confirmed: false,
      candidate: null,
      boundary: null
    });
    expect(result.transitions).toHaveLength(2);
    expect(result.transitions.map((transition) => [
      transition.beforeIndex,
      transition.afterIndex
    ])).toEqual([[0, 1], [2, 3]]);
  });

  it("does not confirm across an unreadable version even when the endpoints differ", () => {
    const result = traceKnowledgeBoundary({
      assertion: containsTarget,
      versions: versions("absent", undefined, "verified claim")
    });

    expect(result).toMatchObject({
      conclusion: "unknown-gap",
      confirmed: false,
      candidate: null,
      boundary: null,
      unknownIndices: [1]
    });
    expect(
      result.probeOrder
        .filter((probe) => probe.phase === "binary")
        .map((probe) => [probe.index, probe.outcome])
    ).toEqual([
      [0, "does-not-hold"],
      [2, "holds"],
      [1, "unknown"]
    ]);
  });

  it("distinguishes stable holds, stable failure, all unknown, and no versions", () => {
    const stableHolds = traceKnowledgeBoundary({
      assertion: containsTarget,
      versions: versions("verified claim", "verified claim")
    });
    const stableFailure = traceKnowledgeBoundary({
      assertion: containsTarget,
      versions: versions("draft", "draft")
    });
    const allUnknown = traceKnowledgeBoundary({
      assertion: containsTarget,
      versions: versions(undefined, undefined)
    });
    const empty = traceKnowledgeBoundary({
      assertion: containsTarget,
      versions: []
    });

    expect(stableHolds).toMatchObject({
      conclusion: "stable",
      stableOutcome: "holds",
      confirmed: false
    });
    expect(stableFailure).toMatchObject({
      conclusion: "stable",
      stableOutcome: "does-not-hold",
      confirmed: false
    });
    expect(allUnknown).toMatchObject({
      conclusion: "all-unknown",
      confirmed: false,
      unknownIndices: [0, 1]
    });
    expect(empty).toMatchObject({
      conclusion: "empty",
      confirmed: false,
      evaluations: []
    });
  });
});
