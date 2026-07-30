import { describe, expect, it } from "vitest";
import {
  appendRecoveryBasketItem,
  buildRecoveryBasketPlan,
  createRecoveryBasket,
  createRecoveryBasketItem,
  createRecoveryPatches
} from "../src/recovery-basket/planner";
import { createPropertyRecoveryItem } from "../src/recovery-basket/property-patch";
import {
  CURRENT_DATA_SCHEMA_VERSION,
  migratePluginData
} from "../src/persistence/plugin-data";

const source = (hash: string) => ({
  versionKey: `commit:${hash}`,
  label: `${hash.slice(0, 7)} · test`,
  commitHash: hash,
  shortHash: hash.slice(0, 7),
  historicalPath: "Note.md"
});

function hunkItem(
  baseline: string,
  target: string,
  id: string,
  label = id
) {
  return createRecoveryBasketItem({
    id,
    addedAt: "2026-07-30T00:00:00.000Z",
    filePath: "Note.md",
    kind: "hunk",
    label,
    source: source(id.repeat(40).slice(0, 40)),
    patches: createRecoveryPatches(baseline, target),
    previewBefore: baseline,
    previewAfter: target
  });
}

describe("recovery basket planner", () => {
  it("combines non-overlapping changes from different historical versions", () => {
    const baseline = "# Note\n\ncurrent method\n\nkeep\n\ncurrent conclusion\n";
    let basket = createRecoveryBasket("Note.md", baseline, "2026-07-30T00:00:00.000Z");
    basket = appendRecoveryBasketItem(
      basket,
      hunkItem(
        baseline,
        "# Note\n\nold method\n\nkeep\n\ncurrent conclusion\n",
        "a",
        "旧版方法"
      ),
      baseline
    );
    basket = appendRecoveryBasketItem(
      basket,
      hunkItem(
        baseline,
        "# Note\n\ncurrent method\n\nkeep\n\nnewer conclusion\n",
        "b",
        "新版结论"
      ),
      baseline
    );

    const plan = buildRecoveryBasketPlan(basket, baseline);

    expect(plan.canApply).toBe(true);
    expect(plan.targetContent).toContain("old method");
    expect(plan.targetContent).toContain("newer conclusion");
    expect(plan.appliedItemIds).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("blocks overlapping edits from different versions", () => {
    const baseline = "# Note\n\ncurrent paragraph\n";
    let basket = createRecoveryBasket("Note.md", baseline);
    basket = appendRecoveryBasketItem(
      basket,
      hunkItem(baseline, "# Note\n\nfirst history\n", "a"),
      baseline
    );
    basket = appendRecoveryBasketItem(
      basket,
      hunkItem(baseline, "# Note\n\nsecond history\n", "b"),
      baseline
    );

    const plan = buildRecoveryBasketPlan(basket, baseline);

    expect(plan.canApply).toBe(false);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "overlap", severity: "blocking" })
    ]));
  });

  it("deduplicates identical items without applying the patch twice", () => {
    const baseline = "# Note\n\ncurrent\n";
    const target = "# Note\n\nhistory\n";
    let basket = createRecoveryBasket("Note.md", baseline);
    basket = appendRecoveryBasketItem(basket, hunkItem(baseline, target, "a"), baseline);
    basket = appendRecoveryBasketItem(basket, hunkItem(baseline, target, "b"), baseline);

    const plan = buildRecoveryBasketPlan(basket, baseline);

    expect(plan.canApply).toBe(true);
    expect(plan.targetContent).toBe(target);
    expect(plan.skippedDuplicateItemIds).toEqual(["b"]);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "duplicate-item", severity: "warning" })
    ]));
  });

  it("blocks apply when the note diverges from the frozen baseline", () => {
    const baseline = "# Note\n\ncurrent\n";
    let basket = createRecoveryBasket("Note.md", baseline);
    basket = appendRecoveryBasketItem(
      basket,
      hunkItem(baseline, "# Note\n\nhistory\n", "a"),
      baseline
    );

    const plan = buildRecoveryBasketPlan(basket, `${baseline}\nnew edit\n`);

    expect(plan.stale).toBe(true);
    expect(plan.canApply).toBe(false);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "stale", severity: "blocking" })
    ]));
  });

  it("warns when the final plan removes a note relation", () => {
    const baseline = "# Note\n\nSee [[Source]].\n";
    const target = "# Note\n\nNo source.\n";
    let basket = createRecoveryBasket("Note.md", baseline);
    basket = appendRecoveryBasketItem(basket, hunkItem(baseline, target, "a"), baseline);

    const plan = buildRecoveryBasketPlan(basket, baseline);

    expect(plan.canApply).toBe(true);
    expect(plan.removedRelations).toEqual([
      expect.objectContaining({ kind: "wikilink", target: "Source" })
    ]);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "link-removal", severity: "warning" })
    ]));
  });
});

describe("property recovery item", () => {
  it("restores one typed YAML property without replacing the body", () => {
    const current = "---\nstatus: final\ntags:\n  - current\n---\n# Note\n\nCurrent body.\n";
    const historical = "---\nstatus: draft\ntags:\n  - history\n---\n# Note\n\nOld body.\n";
    const item = createPropertyRecoveryItem({
      id: "property-status",
      addedAt: "2026-07-30T00:00:00.000Z",
      filePath: "Note.md",
      propertyName: "status",
      historicalContent: historical,
      currentContent: current,
      source: source("a".repeat(40))
    });
    let basket = createRecoveryBasket("Note.md", current);
    basket = appendRecoveryBasketItem(basket, item, current);

    const plan = buildRecoveryBasketPlan(basket, current);

    expect(plan.canApply).toBe(true);
    expect(plan.targetContent).toContain("status: draft");
    expect(plan.targetContent).toContain("tags:\n  - current");
    expect(plan.targetContent).toContain("Current body.");
    expect(plan.targetContent).not.toContain("Old body.");
  });

  it("blocks two sources that overwrite the same property", () => {
    const current = "---\nstatus: current\n---\nBody\n";
    const first = "---\nstatus: first\n---\nBody\n";
    const second = "---\nstatus: second\n---\nBody\n";
    let basket = createRecoveryBasket("Note.md", current);
    basket = appendRecoveryBasketItem(
      basket,
      createPropertyRecoveryItem({
        id: "first",
        filePath: "Note.md",
        propertyName: "status",
        historicalContent: first,
        currentContent: current,
        source: source("a".repeat(40))
      }),
      current
    );
    basket = appendRecoveryBasketItem(
      basket,
      createPropertyRecoveryItem({
        id: "second",
        filePath: "Note.md",
        propertyName: "status",
        historicalContent: second,
        currentContent: current,
        source: source("b".repeat(40))
      }),
      current
    );

    const plan = buildRecoveryBasketPlan(basket, current);

    expect(plan.canApply).toBe(false);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "property-overwrite", severity: "blocking" })
    ]));
  });
});

describe("recovery basket persistence", () => {
  it("round-trips one valid frozen basket through the current data schema", () => {
    const baseline = "# Note\n\nCurrent.\n";
    let basket = createRecoveryBasket(
      "Note.md",
      baseline,
      "2026-07-30T00:00:00.000Z"
    );
    basket = appendRecoveryBasketItem(
      basket,
      hunkItem(baseline, "# Note\n\nHistorical.\n", "a"),
      baseline,
      "2026-07-30T00:01:00.000Z"
    );

    const first = migratePluginData({
      recoveryBaskets: { "wrong-map-key": basket }
    });
    const second = migratePluginData(first);

    expect(first.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    expect(first.recoveryBaskets?.["Note.md"]).toEqual(basket);
    expect(second).toEqual(first);
  });

  it("drops baskets whose frozen content does not match their fingerprint", () => {
    const basket = createRecoveryBasket("Note.md", "# Note\n");
    basket.baselineContent = "# Tampered\n";

    const data = migratePluginData({
      recoveryBaskets: { "Note.md": basket }
    });

    expect(data.recoveryBaskets).toEqual({});
  });

  it("drops malformed items but preserves the valid basket shell", () => {
    const basket = createRecoveryBasket("Note.md", "# Note\n");
    const data = migratePluginData({
      recoveryBaskets: {
        "Note.md": {
          ...basket,
          items: [{
            id: "broken",
            filePath: "Note.md",
            kind: "hunk",
            operation: "replace"
          }]
        }
      }
    });

    expect(data.recoveryBaskets?.["Note.md"]?.items).toEqual([]);
  });
});
