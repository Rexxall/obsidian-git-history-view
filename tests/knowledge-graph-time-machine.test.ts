import { describe, expect, it } from "vitest";
import {
  buildKnowledgeGraphTimeline,
  filterKnowledgeGraphTransitions,
  GRAPH_TIME_MACHINE_MAX_VERSIONS,
  type KnowledgeGraphVersion
} from "../src/knowledge-graph/time-machine";
import {
  buildRecoveryImpactWave,
  extractKnowledgeAnchors
} from "../src/analysis/recovery-impact";
import { extractNoteRelations } from "../src/analysis/link-impact";

function version(
  id: string,
  content: string | undefined,
  availability: KnowledgeGraphVersion["availability"] = "ready"
): KnowledgeGraphVersion {
  return {
    id,
    label: id,
    capturedAt: `2026-07-${String(Number(id.replace(/\D/gu, "")) || 1).padStart(2, "0")}T00:00:00.000Z`,
    reference: { kind: "working", label: id },
    availability,
    ...(content === undefined ? {} : { content })
  };
}

describe("knowledge graph time machine", () => {
  it("keeps only actual relationship transitions on the focused timeline", () => {
    const timeline = buildKnowledgeGraphTimeline([
      version("v1", "# A\n[[One]] #draft"),
      version("v2", "# A\n[[One]] #draft\nMore prose"),
      version("v3", "# A\n[[Two]] #reviewed")
    ]);

    expect(timeline.transitions.map((item) => item.status)).toEqual([
      "stable",
      "changed"
    ]);
    expect(timeline.changedTransitions).toHaveLength(1);
    expect(timeline.changedTransitions[0]?.added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "Two" }),
        expect.objectContaining({ target: "reviewed", kind: "tag" })
      ])
    );
  });

  it("does not infer changes across an unreadable version", () => {
    const timeline = buildKnowledgeGraphTimeline([
      version("v1", "[[One]]"),
      version("v2", undefined, "unavailable"),
      version("v3", "[[Two]]")
    ]);
    expect(timeline.transitions.every((item) => item.status === "gap")).toBe(true);
    expect(timeline.changedTransitions).toEqual([]);
  });

  it("filters transitions by relationship kind without retaining empty events", () => {
    const timeline = buildKnowledgeGraphTimeline([
      version("v1", "[[One]] #draft"),
      version("v2", "[[Two]] #draft"),
      version("v3", "[[Two]] #reviewed")
    ]);
    const filtered = filterKnowledgeGraphTransitions(
      timeline,
      new Set(["tag"])
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.added[0]).toMatchObject({
      kind: "tag",
      target: "reviewed"
    });
  });

  it("keeps the most recent bounded window and reports truncation", () => {
    const versions = Array.from(
      { length: GRAPH_TIME_MACHINE_MAX_VERSIONS + 3 },
      (_, index) => version(`v${index + 1}`, `[[Note ${index + 1}]]`)
    );
    const timeline = buildKnowledgeGraphTimeline(versions);
    expect(timeline.versions).toHaveLength(GRAPH_TIME_MACHINE_MAX_VERSIONS);
    expect(timeline.versions[0]?.id).toBe("v4");
    expect(timeline.truncated).toBe(true);
  });

  it("separates attachments, embeds, anchors, and footnotes", () => {
    const relations = extractNoteRelations(
      "[[Note#Section]] ![[Other#Part]] ![[image.png]] [^source]\n[^source]: citation"
    );
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "wikilink", target: "Note", subpath: "#Section" }),
      expect.objectContaining({ kind: "embed", target: "Other", subpath: "#Part" }),
      expect.objectContaining({ kind: "attachment", target: "image.png" }),
      expect.objectContaining({ kind: "footnote", target: "source" })
    ]));
    expect(relations.filter((relation) => relation.kind === "footnote")).toHaveLength(1);
  });
});

describe("recovery impact wave", () => {
  it("finds headings and block anchors without treating prose as an anchor", () => {
    expect(extractKnowledgeAnchors(
      "# Main heading\nText ^block-id\n## Details!\nOrdinary line"
    )).toEqual(["main heading", "block-id", "details"]);
  });

  it("reports missing historical attachments and links before restoration", () => {
    const wave = buildRecoveryImpactWave(
      "[[Current]]",
      "[[Old Note]] ![[gone.pdf]]",
      {
        resolvesTarget: (relation) => relation.target === "Old Note"
      }
    );
    expect(wave.severity).toBe("danger");
    expect(wave.restoredRelations).toEqual([
      expect.objectContaining({ target: "Old Note" })
    ]);
    expect(wave.missingAttachments).toEqual([
      expect.objectContaining({ target: "gone.pdf", kind: "attachment" })
    ]);
  });

  it("detects backlinks to headings and block anchors removed by restoration", () => {
    const wave = buildRecoveryImpactWave(
      "# Current heading\nParagraph ^current-block",
      "# Old heading\nParagraph",
      {
        incomingReferences: [
          {
            sourcePath: "Other.md",
            sourceLabel: "Other",
            kind: "link",
            subpath: "#Current heading"
          },
          {
            sourcePath: "Dashboard.md",
            sourceLabel: "Dashboard",
            kind: "embed",
            subpath: "^current-block"
          }
        ]
      }
    );
    expect(wave.brokenIncomingReferences).toHaveLength(2);
    expect(wave.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "broken-inbound-anchor", severity: "danger" })
    ]));
  });

  it("detects an inbound alias that the historical version removes", () => {
    const current = "---\naliases:\n  - Current Name\n---\n# Note";
    const target = "---\naliases: [Old Name]\n---\n# Note";
    const wave = buildRecoveryImpactWave(current, target, {
      incomingReferences: [{
        sourcePath: "Index.md",
        sourceLabel: "Index",
        kind: "link",
        viaAlias: "Current Name"
      }]
    });
    expect(wave.brokenIncomingReferences).toHaveLength(1);
    expect(wave.findings[0]).toMatchObject({ kind: "broken-alias" });
  });

  it("returns a concise safe result when restored relations resolve", () => {
    const wave = buildRecoveryImpactWave("", "[[Existing]]", {
      resolvesTarget: () => true
    });
    expect(wave.severity).toBe("safe");
    expect(wave.summary).toContain("未发现");
  });
});
