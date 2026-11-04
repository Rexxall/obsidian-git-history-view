import { describe, expect, it } from "vitest";
import { contentSimilarity, pickSimilarRename } from "../src/git/rename-similarity";

const essay = Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of the essay about weekends.`).join("\n") + "\n";

describe("matching an edited move by content", () => {
  it("scores identical text as 1 and unrelated text near 0", () => {
    expect(contentSimilarity(essay, essay)).toBe(1);
    expect(contentSimilarity(essay, "something else entirely\n")).toBeLessThan(0.1);
  });

  it("picks the note that was moved and lightly edited", () => {
    const edited = essay.replace("Line 3 of the essay about weekends.", "Line 3, rewritten after the move.") + "A new closing line.\n";
    const match = pickSimilarRename(edited, [
      { path: "Notes/Weekend essay.md", content: essay },
      { path: "Notes/Other.md", content: "a short unrelated note\n" }
    ]);
    expect(match?.path).toBe("Notes/Weekend essay.md");
    expect(match!.similarity).toBeGreaterThan(0.8);
  });

  it("guesses nothing when two candidates are about as close", () => {
    const template = "## Meeting\n\n- Date:\n- People:\n- Notes:\n- Next steps:\n";
    const match = pickSimilarRename(`${template}- Extra\n`, [
      { path: "Meetings/A.md", content: `${template}- A\n` },
      { path: "Meetings/B.md", content: `${template}- B\n` }
    ]);
    expect(match).toBeNull();
  });

  it("guesses nothing when less than half is kept", () => {
    const match = pickSimilarRename("mostly new text\nwith one old line\nLine 1 of the essay about weekends.\n", [
      { path: "Notes/Weekend essay.md", content: essay }
    ]);
    expect(match).toBeNull();
  });
});
