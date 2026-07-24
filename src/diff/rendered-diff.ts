import { diffArrays } from "diff";
import {
  extractMarkdownBlocks,
  type MarkdownBlock
} from "../history/markdown-blocks";

export type RenderedDiffKind = "unchanged" | "added" | "removed" | "changed";

export interface RenderedDiffSection {
  kind: RenderedDiffKind;
  before: MarkdownBlock[];
  after: MarkdownBlock[];
}

export interface RenderedDiffOptions {
  ignoreWhitespace?: boolean;
  ignoreFrontmatter?: boolean;
}

function normalizedBlock(block: MarkdownBlock, ignoreWhitespace: boolean): string {
  const content = block.content.replace(/\r\n/g, "\n");
  return ignoreWhitespace ? content.replace(/\s+/g, " ").trim() : content;
}

export function stripFrontmatter(content: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return content;
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingIndex < 0) return content;
  const body = lines.slice(closingIndex + 2);
  while (body[0]?.trim() === "") body.shift();
  return body.join(newline);
}

export function buildRenderedDiff(
  before: string,
  after: string,
  options: RenderedDiffOptions = {}
): RenderedDiffSection[] {
  const ignoreWhitespace = options.ignoreWhitespace ?? false;
  const beforeBlocks = extractMarkdownBlocks(before)
    .filter((block) => !options.ignoreFrontmatter || block.kind !== "frontmatter");
  const afterBlocks = extractMarkdownBlocks(after)
    .filter((block) => !options.ignoreFrontmatter || block.kind !== "frontmatter");
  const changes = diffArrays(beforeBlocks, afterBlocks, {
    comparator: (left, right) =>
      normalizedBlock(left, ignoreWhitespace) === normalizedBlock(right, ignoreWhitespace)
  });
  const sections: RenderedDiffSection[] = [];

  for (let index = 0; index < changes.length; index += 1) {
    const current = changes[index]!;
    const next = changes[index + 1];
    if (current.removed && next?.added) {
      sections.push({ kind: "changed", before: current.value, after: next.value });
      index += 1;
      continue;
    }
    if (current.added && next?.removed) {
      sections.push({ kind: "changed", before: next.value, after: current.value });
      index += 1;
      continue;
    }
    if (current.added) {
      sections.push({ kind: "added", before: [], after: current.value });
    } else if (current.removed) {
      sections.push({ kind: "removed", before: current.value, after: [] });
    } else {
      sections.push({ kind: "unchanged", before: current.value, after: current.value });
    }
  }

  return sections;
}
