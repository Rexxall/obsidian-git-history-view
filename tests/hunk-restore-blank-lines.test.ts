import { describe, expect, it } from "vitest";
import { restorableHunks } from "../src/ui/diff-renderer";

const past = ["# Plan", "", "first", "", "second", "", "third", ""].join("\n");
const now = ["# Plan", "", "first", "second changed", "", "third", ""].join("\n");

describe("partial restore with blank lines hidden", () => {
  it("still offers changes that are visible", () => {
    const shown = restorableHunks(past, now, true);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.some((target) => target.historicalBlock.includes("second") && target.currentBlock.includes("second changed"))).toBe(true);
  });

  it("leaves out changes that only touch blank lines", () => {
    const spaced = ["a", "", "", "b", ""].join("\n");
    const tight = ["a", "", "b", ""].join("\n");
    expect(restorableHunks(spaced, tight, false)).toHaveLength(1);
    expect(restorableHunks(spaced, tight, true)).toHaveLength(0);
  });
});
