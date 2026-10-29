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
