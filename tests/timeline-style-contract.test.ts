import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("timeline style contract", () => {
  it("keeps the full-row activation button visually transparent", () => {
    const trigger = rule(".git-note-history-row-trigger");

    expect(trigger).toContain("appearance: none !important");
    expect(trigger).toContain("background: transparent !important");
    expect(trigger).toContain("background-image: none !important");
    expect(trigger).toContain("box-shadow: none !important");
  });

  it("renders timeline text above the full-row activation button", () => {
    const trigger = rule(".git-note-history-row-trigger");
    const content = rule(".git-note-history-commit-content");
    const rail = rule(".git-note-history-rail");

    expect(trigger).toContain("z-index: 1");
    expect(content).toContain("position: relative");
    expect(content).toContain("z-index: 2");
    expect(rail).toContain("z-index: 2");
  });
});
