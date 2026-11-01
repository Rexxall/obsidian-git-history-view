import { structuredPatch } from "diff";
import { tr } from "../i18n";

export interface ChangeMapItem {
  id: number;
  title: string;
  level: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: number;
  deletedLines: number;
  kind: "added" | "removed" | "changed";
}

interface HeadingPosition {
  line: number;
  title: string;
  level: number;
}

function headings(content: string): HeadingPosition[] {
  const result: HeadingPosition[] = [];
  content.replace(/\r\n/g, "\n").split("\n").forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (match?.[1] && match[2]) {
      result.push({ line: index + 1, title: match[2].trim(), level: match[1].length });
    }
  });
  return result;
}

function headingAt(items: HeadingPosition[], line: number): HeadingPosition | undefined {
  let selected: HeadingPosition | undefined;
  for (const item of items) {
    if (item.line > line) break;
    selected = item;
  }
  return selected;
}

export function buildChangeMap(before: string, after: string): ChangeMapItem[] {
  const beforeHeadings = headings(before);
  const afterHeadings = headings(after);
  const patch = structuredPatch("before", "after", before, after, "", "", { context: 0 });
  return patch.hunks.map((hunk, index) => {
    const addedLines = hunk.lines.filter((line) => line.startsWith("+")).length;
    const deletedLines = hunk.lines.filter((line) => line.startsWith("-")).length;
    const heading = headingAt(afterHeadings, Math.max(1, hunk.newStart))
      ?? headingAt(beforeHeadings, Math.max(1, hunk.oldStart));
    return {
      id: index + 1,
      title: heading?.title ?? (hunk.newStart <= 1 || hunk.oldStart <= 1 ? tr("属性与文首", "Properties and top") : tr("正文", "Text")),
      level: heading?.level ?? 1,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      addedLines,
      deletedLines,
      kind: addedLines > 0 && deletedLines > 0 ? "changed" : addedLines > 0 ? "added" : "removed"
    };
  });
}

export interface ChangeLocation {
  /** 1-based line in the current note. */
  line: number;
  /** The change was found as it is; otherwise the line is only near it. */
  exact: boolean;
  /** The right side removes these lines, so the line is where they used to be. */
  removed: boolean;
}

/** What the compare knows about one change on its right side. */
export interface ChangeLandmark {
  /** First non-blank right-side line of the change; empty when the change only removes lines. */
  text: string;
  /** Last non-blank unchanged line before the change. */
  before: string;
  /** Right-side line number of the change, used to pick between repeats and as the fallback. */
  line: number;
}

const sameLine = (a: string, b: string): boolean => a.trimEnd() === b.trimEnd();

function nearestMatch(lines: string[], text: string, near: number): number | null {
  let best: number | null = null;
  lines.forEach((line, index) => {
    if (sameLine(line, text) && (best === null || Math.abs(index - near) < Math.abs(best - near))) best = index;
  });
  return best;
}

// The note may have moved on since the right side was written, so a change is looked up by its text.
export function locateLandmarkInNote(landmark: ChangeLandmark, currentContent: string): ChangeLocation {
  const current = currentContent.replace(/\r\n/g, "\n").split("\n");
  const clamp = (line: number): number => Math.max(1, Math.min(line, current.length));
  const near = Math.max(0, landmark.line - 1);
  if (landmark.text.trim()) {
    const found = nearestMatch(current, landmark.text, near);
    return found !== null
      ? { line: found + 1, exact: true, removed: false }
      : { line: clamp(landmark.line), exact: false, removed: false };
  }
  const before = landmark.before.trim() ? nearestMatch(current, landmark.before, near - 1) : null;
  return before !== null
    ? { line: clamp(before + 2), exact: true, removed: true }
    : { line: clamp(landmark.line), exact: false, removed: true };
}

// Landmark for a change map item, read from the right side's text.
export function landmarkForChange(item: ChangeMapItem, rightContent: string): ChangeLandmark {
  const right = rightContent.replace(/\r\n/g, "\n").split("\n");
  const added = right.slice(item.newStart - 1, item.newStart - 1 + item.newLines);
  const offset = added.findIndex((line) => line.trim());
  // Lines above the change; for a pure removal jsdiff's newStart is the line just after the gap, so this holds too.
  const before = right.slice(0, item.newStart - 1).reverse().find((line) => line.trim()) ?? "";
  return {
    text: offset >= 0 ? added[offset]! : "",
    before,
    line: offset >= 0 ? item.newStart + offset : item.newStart
  };
}

export function locateChangeInNote(item: ChangeMapItem, rightContent: string, currentContent: string): ChangeLocation {
  return locateLandmarkInNote(landmarkForChange(item, rightContent), currentContent);
}
