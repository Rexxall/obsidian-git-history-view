import { describe, expect, it } from "vitest";
import { formatTimeAgo } from "../src/history/relative-time";
import {
  buildVersionLink,
  buildVersionMarkdownLink,
  parseVersionLinkParams
} from "../src/history/version-link";

describe("status bar time", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");

  it("speaks in minutes, hours and days, then falls back to the date", () => {
    expect(formatTimeAgo("2026-10-29T11:59:30Z", now, false)).toBe("just now");
    expect(formatTimeAgo("2026-10-29T11:55:00Z", now, false)).toBe("5 min ago");
    expect(formatTimeAgo("2026-10-29T09:00:00Z", now, true)).toBe("3 小时前");
    expect(formatTimeAgo("2026-10-28T11:00:00Z", now, false)).toBe("1 day ago");
    expect(formatTimeAgo("2026-10-20T12:00:00Z", now, true)).toBe("9 天前");
    expect(formatTimeAgo("2026-08-01T12:00:00Z", now, false)).toBe("2026-08-01");
  });

  it("never shows a negative age or garbage for bad input", () => {
    expect(formatTimeAgo("2026-10-29T13:00:00Z", now, false)).toBe("just now");
    expect(formatTimeAgo("not a date", now, false)).toBe("");
  });
});

describe("version links", () => {
  it("round-trips a path with spaces and non-ASCII characters", () => {
    const link = buildVersionLink("My vault", "笔记/Research plan v2.md", "0123abcd0123abcd0123abcd0123abcd0123abcd");
    expect(link.startsWith("obsidian://git-note-history?vault=My%20vault&file=")).toBe(true);
    const params = Object.fromEntries(new URL(link).searchParams.entries());
    expect(parseVersionLinkParams(params)).toEqual({
      filePath: "笔记/Research plan v2.md",
      commit: "0123abcd0123abcd0123abcd0123abcd0123abcd"
    });
  });

  it("rejects links without a file or with something that is not a commit hash", () => {
    expect(parseVersionLinkParams({ commit: "0123abc" })).toBeNull();
    expect(parseVersionLinkParams({ file: "a.md", commit: "HEAD~1" })).toBeNull();
    expect(parseVersionLinkParams({ file: "a.md", commit: "--output=x" })).toBeNull();
  });

  it("keeps the Markdown label from breaking the link", () => {
    expect(buildVersionMarkdownLink("v", "a.md", "abcdef1", "a [sent] 10-26")).toBe(
      "[a sent 10-26](obsidian://git-note-history?vault=v&file=a.md&commit=abcdef1)"
    );
  });
});
