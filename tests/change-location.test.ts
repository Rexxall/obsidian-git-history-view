import { describe, expect, it } from "vitest";
import { buildChangeMap, locateChangeInNote } from "../src/diff/change-map";

const before = ["# Plan", "", "first", "second", "third", "", "## Notes", "end"].join("\n");
const after = ["# Plan", "", "first", "second changed", "third", "", "## Notes", "end"].join("\n");

describe("locating a change in the current note", () => {
  it("finds the line when the note still matches the right side", () => {
    const [item] = buildChangeMap(before, after);
    expect(locateChangeInNote(item!, after, after)).toEqual({ line: 4, exact: true, removed: false });
  });

  it("follows the text when lines were added above it since", () => {
    const [item] = buildChangeMap(before, after);
    const now = ["# Plan", "", "new intro", "new intro 2", "first", "second changed", "third", "", "## Notes", "end"].join("\n");
    expect(locateChangeInNote(item!, after, now)).toEqual({ line: 6, exact: true, removed: false });
  });

  it("says the place is only approximate when the changed text is gone from the note", () => {
    const [item] = buildChangeMap(before, after);
    const now = ["# Plan", "", "first", "rewritten again", "third", "", "## Notes", "end"].join("\n");
    expect(locateChangeInNote(item!, after, now)).toEqual({ line: 4, exact: false, removed: false });
  });

  it("points at where removed lines used to be", () => {
    const removed = ["# Plan", "", "first", "third", "", "## Notes", "end"].join("\n");
    const [item] = buildChangeMap(before, removed);
    expect(item!.newLines).toBe(0);
    expect(locateChangeInNote(item!, removed, removed)).toEqual({ line: 4, exact: true, removed: true });
  });
});
