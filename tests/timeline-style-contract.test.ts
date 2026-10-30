import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const core = readFileSync(new URL("../styles/core.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return core.match(new RegExp(`(?:^|\\n\\n|\\*/\\n)${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("timeline style contract", () => {
  it("keeps the full-row activation button as an invisible overlay", () => {
    const trigger = rule(".git-note-history-row-trigger");

    expect(trigger).toContain("position: absolute");
    expect(trigger).toContain("inset: 0");
    expect(trigger).toContain("opacity: 0");
    expect(trigger).toContain("z-index: 1");
  });

  it("renders timeline text and actions above the activation button", () => {
    const content = rule(".git-note-history-commit-content");
    const rail = rule(".git-note-history-rail");
    const actions = rule(".git-note-history-row-actions");

    for (const block of [content, rail, actions]) {
      expect(block).toContain("position: relative");
      expect(block).toContain("z-index: 2");
    }
  });

  it("shows keyboard focus on the row instead of the hidden button", () => {
    expect(rule(".git-note-history-commit.is-focus-visible")).toContain("box-shadow");
  });

  it("ships without !important, :has or all, and with the built stylesheet in sync", () => {
    expect(styles.match(/!important/g)).toBeNull();
    expect(styles).not.toMatch(/:has\(/);
    expect(styles).not.toMatch(/(^|[\s;{])all\s*:/);
    expect(styles).toContain(core.trimEnd());
  });
});
