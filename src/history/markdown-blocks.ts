export interface MarkdownBlock {
  startLine: number;
  endLine: number;
  content: string;
  headingPath: string[];
  kind: "heading" | "paragraph" | "list" | "code" | "frontmatter";
}

export interface MarkdownBlockMatch {
  block: MarkdownBlock;
  score: number;
}

function stripMarkdown(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[\s>*#\-+\d.)\[\]xX_`~]+/gm, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  const normalized = stripMarkdown(value);
  if (!normalized) return new Set();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 1) return new Set(words);
  const chars = Array.from(normalized.replace(/\s+/g, ""));
  if (chars.length <= 2) return new Set(chars);
  return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function classify(lines: string[]): MarkdownBlock["kind"] {
  const first = lines.find((line) => line.trim() !== "")?.trim() ?? "";
  if (first === "---") return "frontmatter";
  if (/^#{1,6}\s+/.test(first)) return "heading";
  if (/^```|^~~~/.test(first)) return "code";
  if (/^(?:[-+*]|\d+[.)])\s+/.test(first)) return "list";
  return "paragraph";
}

export function extractMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const headingPath: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index]?.trim() === "") {
      index += 1;
      continue;
    }

    const start = index;
    const first = lines[index] ?? "";
    let end = index;

    if (start === 0 && first.trim() === "---") {
      end += 1;
      while (end < lines.length && lines[end]?.trim() !== "---") end += 1;
      if (end < lines.length) end += 1;
    } else if (/^\s*(```|~~~)/.test(first)) {
      const fence = first.match(/^\s*(```|~~~)/)?.[1] ?? "```";
      end += 1;
      while (end < lines.length && !lines[end]?.trimStart().startsWith(fence)) end += 1;
      if (end < lines.length) end += 1;
    } else if (/^#{1,6}\s+/.test(first)) {
      end += 1;
    } else {
      end += 1;
      while (end < lines.length && lines[end]?.trim() !== "" && !/^#{1,6}\s+/.test(lines[end] ?? "")) {
        end += 1;
      }
    }

    const blockLines = lines.slice(start, end);
    const heading = first.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1]!.length;
      headingPath.splice(level - 1);
      headingPath[level - 1] = heading[2]!.trim();
    }
    blocks.push({
      startLine: start,
      endLine: Math.max(start, end - 1),
      content: blockLines.join("\n"),
      headingPath: headingPath.filter(Boolean),
      kind: classify(blockLines)
    });
    index = Math.max(end, start + 1);
  }
  return blocks;
}

export function findBlockAtLines(content: string, startLine: number, endLine: number): MarkdownBlock | null {
  const start = Math.max(0, startLine);
  const end = Math.max(start, endLine);
  const blocks = extractMarkdownBlocks(content);
  return blocks.find((block) => block.startLine <= end && block.endLine >= start) ?? null;
}

export function findBestMatchingBlock(
  source: Pick<MarkdownBlock, "content" | "headingPath" | "kind">,
  historicalContent: string
): MarkdownBlockMatch | null {
  const sourceNormalized = stripMarkdown(source.content);
  const sourceTokens = tokens(source.content);
  const sourceHeading = source.headingPath.join(" / ").toLocaleLowerCase();
  let best: MarkdownBlockMatch | null = null;

  for (const block of extractMarkdownBlocks(historicalContent)) {
    const candidateNormalized = stripMarkdown(block.content);
    let score = sourceNormalized && sourceNormalized === candidateNormalized
      ? 1
      : jaccard(sourceTokens, tokens(block.content));
    if (block.kind === source.kind) score += 0.05;
    const candidateHeading = block.headingPath.join(" / ").toLocaleLowerCase();
    if (sourceHeading && candidateHeading === sourceHeading) score += 0.12;
    else if (sourceHeading && candidateHeading && sourceHeading.split(" / ").at(-1) === candidateHeading.split(" / ").at(-1)) score += 0.06;
    score = Math.min(1, score);
    if (!best || score > best.score) best = { block, score };
  }

  return best && best.score >= 0.16 ? best : null;
}

export function replaceMarkdownBlock(
  currentContent: string,
  block: Pick<MarkdownBlock, "startLine" | "endLine">,
  replacement: string
): string {
  const newline = currentContent.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(currentContent);
  const lines = currentContent.replace(/\r\n/g, "\n").split("\n");
  if (hadTrailingNewline) lines.pop();
  const replacementLines = replacement.replace(/\r\n/g, "\n").split("\n");
  lines.splice(block.startLine, block.endLine - block.startLine + 1, ...replacementLines);
  return `${lines.join(newline)}${hadTrailingNewline ? newline : ""}`;
}

export function insertAfterMarkdownBlock(
  currentContent: string,
  block: Pick<MarkdownBlock, "endLine">,
  insertion: string
): string {
  const newline = currentContent.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(currentContent);
  const lines = currentContent.replace(/\r\n/g, "\n").split("\n");
  if (hadTrailingNewline) lines.pop();
  const insertionLines = ["", ...insertion.replace(/\r\n/g, "\n").split("\n")];
  lines.splice(block.endLine + 1, 0, ...insertionLines);
  return `${lines.join(newline)}${hadTrailingNewline ? newline : ""}`;
}
