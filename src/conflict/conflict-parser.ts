export type ConflictChoice = "ancestor" | "ours" | "theirs" | "both";

export interface ConflictHunk {
  id: number;
  label: string;
  ours: string;
  ancestor: string;
  theirs: string;
  raw: string;
}

export type ConflictSegment =
  | { type: "text"; content: string }
  | { type: "conflict"; hunk: ConflictHunk };

export interface ParsedConflictDocument {
  segments: ConflictSegment[];
  hunks: ConflictHunk[];
}

function splitPreservingNewlines(content: string): string[] {
  return content.match(/.*(?:\r\n|\n|$)/g)?.filter((line) => line !== "") ?? [];
}

export function parseConflictDocument(content: string): ParsedConflictDocument {
  const lines = splitPreservingNewlines(content);
  const segments: ConflictSegment[] = [];
  const hunks: ConflictHunk[] = [];
  let textBuffer: string[] = [];
  let index = 0;

  const flushText = () => {
    if (textBuffer.length === 0) return;
    segments.push({ type: "text", content: textBuffer.join("") });
    textBuffer = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!/^<<<<<<<(?:\s|$)/.test(line)) {
      textBuffer.push(line);
      index += 1;
      continue;
    }

    const start = index;
    const label = line.replace(/^<<<<<<<\s*/, "").trim() || "本地";
    index += 1;
    const ours: string[] = [];
    const ancestor: string[] = [];
    const theirs: string[] = [];

    while (index < lines.length && !/^(?:\|\|\|\|\|\|\||=======)/.test(lines[index] ?? "")) {
      ours.push(lines[index] ?? "");
      index += 1;
    }
    if (/^\|\|\|\|\|\|\|/.test(lines[index] ?? "")) {
      index += 1;
      while (index < lines.length && !/^=======/.test(lines[index] ?? "")) {
        ancestor.push(lines[index] ?? "");
        index += 1;
      }
    }
    if (!/^=======/.test(lines[index] ?? "")) {
      textBuffer.push(...lines.slice(start, index));
      continue;
    }
    index += 1;
    while (index < lines.length && !/^>>>>>>>/.test(lines[index] ?? "")) {
      theirs.push(lines[index] ?? "");
      index += 1;
    }
    if (!/^>>>>>>>/.test(lines[index] ?? "")) {
      textBuffer.push(...lines.slice(start, index));
      continue;
    }
    index += 1;

    flushText();
    const hunk: ConflictHunk = {
      id: hunks.length + 1,
      label,
      ours: ours.join(""),
      ancestor: ancestor.join(""),
      theirs: theirs.join(""),
      raw: lines.slice(start, index).join("")
    };
    hunks.push(hunk);
    segments.push({ type: "conflict", hunk });
  }
  flushText();
  return { segments, hunks };
}

function ensureSeparated(left: string, right: string): string {
  if (!left || !right) return `${left}${right}`;
  return `${left}${/\r?\n$/.test(left) ? "" : "\n"}${right}`;
}

export function buildResolvedConflict(
  document: ParsedConflictDocument,
  choices: ReadonlyMap<number, ConflictChoice>
): string {
  return document.segments.map((segment) => {
    if (segment.type === "text") return segment.content;
    const choice = choices.get(segment.hunk.id);
    if (choice === "ancestor") return segment.hunk.ancestor;
    if (choice === "ours") return segment.hunk.ours;
    if (choice === "theirs") return segment.hunk.theirs;
    if (choice === "both") return ensureSeparated(segment.hunk.ours, segment.hunk.theirs);
    return segment.hunk.raw;
  }).join("");
}
