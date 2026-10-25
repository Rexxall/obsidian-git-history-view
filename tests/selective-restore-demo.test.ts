import { describe, expect, it } from "vitest";
import {
  appendRecoveryBasketItem,
  buildRecoveryBasketPlan,
  createRecoveryBasket,
  createRecoveryBasketItem,
  createRecoveryPatches
} from "../src/recovery-basket/planner";

// The problem this plugin exists for: restoring a whole old version brings back one lost
// paragraph but also deletes everything written since. Restoring only the chosen part keeps both.
const filler = ["", "a", "", "b", "", "c", "", "d", ""].join("\n");
const oldVersion = `# Note\n\nlost idea\n${filler}\nend\n`;
const current = `# Note\n\n${filler}\nend\n\nwritten later\n`;

describe("selective restore vs whole-version restore", () => {
  it("whole-version restore would delete the paragraph written later", () => {
    expect(oldVersion).toContain("lost idea");
    expect(oldVersion).not.toContain("written later");
  });

  it("restoring only the chosen part keeps later writing", () => {
    const hunks = createRecoveryPatches(current, oldVersion);
    expect(hunks.length).toBe(2);
    const chosen = hunks.filter((hunk) => hunk.lines.some((line) => line === "+lost idea"));
    expect(chosen.length).toBe(1);

    let basket = createRecoveryBasket("Note.md", current, "2026-10-23T00:00:00.000Z");
    basket = appendRecoveryBasketItem(basket, createRecoveryBasketItem({
      id: "lost-idea",
      addedAt: "2026-10-23T00:00:00.000Z",
      filePath: "Note.md",
      kind: "hunk",
      label: "旧版里被删掉的想法",
      source: {
        versionKey: "commit:" + "a".repeat(40),
        label: "aaaaaaa · old",
        commitHash: "a".repeat(40),
        shortHash: "aaaaaaa",
        historicalPath: "Note.md"
      },
      patches: chosen,
      previewBefore: current,
      previewAfter: oldVersion
    }), current);

    const plan = buildRecoveryBasketPlan(basket, current);
    expect(plan.canApply).toBe(true);
    expect(plan.targetContent).toContain("lost idea");
    expect(plan.targetContent).toContain("written later");
  });
});
