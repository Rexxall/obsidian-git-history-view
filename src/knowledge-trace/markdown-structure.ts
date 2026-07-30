import { inspectFrontmatter } from "./markdown-source";
import type {
  KnowledgeAssertionEvidence,
  StructureKnowledgeAssertion
} from "./types";

export interface MarkdownStructureMatch {
  structure: StructureKnowledgeAssertion["structure"];
  value: string;
  evidence: KnowledgeAssertionEvidence;
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

interface FenceState {
  marker: "`" | "~";
  length: number;
}

interface FenceOpening extends FenceState {
  info: string;
}

function parseFenceOpening(line: string): FenceOpening | null {
  const match = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return null;
  const markerText = match[1] ?? "";
  const marker = markerText[0];
  if (marker !== "`" && marker !== "~") return null;
  return {
    marker,
    length: markerText.length,
    info: (match[2] ?? "").trim()
  };
}

function isClosingFence(line: string, fence: FenceState): boolean {
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(
    `^\\s*${marker}{${fence.length},}\\s*$`,
    "u"
  ).test(line);
}

function maskRange(
  target: string[],
  start: number,
  end: number
): void {
  for (let index = start; index < end; index += 1) {
    target[index] = " ";
  }
}

/**
 * Replaces comment contents without changing UTF-16 offsets or line endings.
 * JavaScript string indices and Obsidian editor offsets are both UTF-16 code
 * units. Fenced code is left untouched, including comment-like text inside it.
 */
function maskHtmlComments(content: string): string {
  const masked = content.split("");
  const lines = sourceLines(content, 0);
  let fence: FenceState | null = null;
  let inComment = false;

  for (const line of lines) {
    if (fence) {
      if (isClosingFence(line.text, fence)) fence = null;
      continue;
    }

    if (!inComment) {
      const openingFence = parseFenceOpening(line.text);
      if (openingFence) {
        fence = openingFence;
        continue;
      }
    }

    let cursor = 0;
    while (cursor < line.text.length) {
      if (inComment) {
        const closing = line.text.indexOf("-->", cursor);
        if (closing < 0) {
          maskRange(masked, line.start + cursor, line.end);
          cursor = line.text.length;
          continue;
        }
        const afterClosing = closing + 3;
        maskRange(masked, line.start + cursor, line.start + afterClosing);
        inComment = false;
        cursor = afterClosing;
        continue;
      }

      const opening = line.text.indexOf("<!--", cursor);
      if (opening < 0) break;
      const closing = line.text.indexOf("-->", opening + 4);
      if (closing < 0) {
        maskRange(masked, line.start + opening, line.end);
        inComment = true;
        cursor = line.text.length;
        continue;
      }
      const afterClosing = closing + 3;
      maskRange(masked, line.start + opening, line.start + afterClosing);
      cursor = afterClosing;
    }

    if (!inComment) {
      const semanticLine = masked.slice(line.start, line.end).join("");
      const openingFence = parseFenceOpening(semanticLine);
      if (openingFence) fence = openingFence;
    }
  }

  return masked.join("");
}

function backtickRunLength(value: string, start: number): number {
  let end = start;
  while (value[end] === "`") end += 1;
  return end - start;
}

/**
 * Masks paired Markdown code spans while keeping the source string length
 * unchanged. Unclosed backtick runs stay literal.
 */
function maskInlineCodeSpans(value: string): string {
  const masked = value.split("");
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "`") {
      index += 1;
      continue;
    }
    const openingLength = backtickRunLength(value, index);
    let cursor = index + openingLength;
    let closingStart = -1;
    while (cursor < value.length) {
      if (value[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      const candidateLength = backtickRunLength(value, cursor);
      if (candidateLength === openingLength) {
        closingStart = cursor;
        break;
      }
      cursor += candidateLength;
    }
    if (closingStart < 0) {
      index += openingLength;
      continue;
    }
    const end = closingStart + openingLength;
    for (let offset = index; offset < end; offset += 1) {
      masked[offset] = " ";
    }
    index = end;
  }
  return masked.join("");
}

function sourceLines(content: string, offset: number): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const match of content.matchAll(/\r?\n/gu)) {
    const end = match.index;
    lines.push({
      text: content.slice(start, end),
      start: offset + start,
      end: offset + end
    });
    start = end + match[0].length;
  }
  lines.push({
    text: content.slice(start),
    start: offset + start,
    end: offset + content.length
  });
  return lines;
}

function maskInlineCodeSpansOutsideFences(content: string): string {
  const masked = content.split("");
  const lines = sourceLines(content, 0);
  let fence: FenceState | null = null;
  let outsideStart = 0;

  const maskOutsideRange = (start: number, end: number): void => {
    const semantic = maskInlineCodeSpans(content.slice(start, end));
    for (let index = 0; index < semantic.length; index += 1) {
      masked[start + index] = semantic[index]!;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      if (isClosingFence(line.text, fence)) {
        fence = null;
        outsideStart = lines[index + 1]?.start ?? content.length;
      }
      continue;
    }
    const opening = parseFenceOpening(line.text);
    if (!opening) continue;
    maskOutsideRange(outsideStart, line.start);
    fence = opening;
  }

  if (!fence) maskOutsideRange(outsideStart, content.length);
  return masked.join("");
}

function lineEvidence(
  content: string,
  line: SourceLine,
  endLine: SourceLine = line
): KnowledgeAssertionEvidence {
  return {
    start: line.start,
    end: endLine.end,
    excerpt: content.slice(line.start, endLine.end)
  };
}

function normalizeTableHeader(line: string): string {
  return line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim())
    .join(" | ");
}

function addInlineFormulaMatches(
  matches: MarkdownStructureMatch[],
  content: string,
  line: SourceLine
): void {
  const formulaPattern = /(^|[^\\$])\$(?!\$)([^$\n]+?)(?<!\\)\$/gu;
  for (const match of line.text.matchAll(formulaPattern)) {
    const prefixLength = (match[1] ?? "").length;
    const body = (match[2] ?? "").trim();
    if (!body) continue;
    const start = line.start + match.index + prefixLength;
    const source = match[0].slice(prefixLength);
    matches.push({
      structure: "formula",
      value: body,
      evidence: {
        start,
        end: start + source.length,
        excerpt: content.slice(start, start + source.length)
      }
    });
  }
}

export function extractMarkdownStructures(
  content: string
): MarkdownStructureMatch[] {
  const frontmatter = inspectFrontmatter(content);
  const body = frontmatter.state === "absent" ? content : frontmatter.body;
  const offset = frontmatter.state === "absent" ? 0 : frontmatter.bodyStart;
  const commentMaskedBody = maskHtmlComments(body);
  const lines = sourceLines(commentMaskedBody, offset);
  const formulaLines = sourceLines(
    maskInlineCodeSpansOutsideFences(commentMaskedBody),
    offset
  );
  const matches: MarkdownStructureMatch[] = [];
  let fence: FenceState | null = null;
  let blockFormulaStart: SourceLine | null = null;
  let blockFormulaBody: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const formulaLine = formulaLines[index];
    if (!line || !formulaLine) continue;
    if (fence) {
      if (isClosingFence(line.text, fence)) fence = null;
      continue;
    }
    const fenceOpening = parseFenceOpening(line.text);
    if (fenceOpening) {
      const language = fenceOpening.info.split(/\s+/u)[0] ?? "";
      matches.push({
        structure: "code-block",
        value: language,
        evidence: lineEvidence(content, line)
      });
      fence = fenceOpening;
      continue;
    }

    if (blockFormulaStart) {
      const closingIndex = formulaLine.text.indexOf("$$");
      if (closingIndex >= 0) {
        blockFormulaBody.push(formulaLine.text.slice(0, closingIndex));
        matches.push({
          structure: "formula",
          value: blockFormulaBody.join("\n").trim(),
          evidence: lineEvidence(content, blockFormulaStart, line)
        });
        blockFormulaStart = null;
        blockFormulaBody = [];
      } else {
        blockFormulaBody.push(formulaLine.text);
      }
      continue;
    }

    const trimmed = formulaLine.text.trim();
    if (trimmed.startsWith("$$")) {
      const rest = trimmed.slice(2);
      const closingIndex = rest.indexOf("$$");
      if (closingIndex >= 0) {
        matches.push({
          structure: "formula",
          value: rest.slice(0, closingIndex).trim(),
          evidence: lineEvidence(content, line)
        });
      } else {
        blockFormulaStart = line;
        blockFormulaBody = [rest];
      }
      continue;
    }

    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line.text);
    if (heading) {
      matches.push({
        structure: "heading",
        value: (heading[1] ?? "").trim(),
        evidence: lineEvidence(content, line)
      });
    }

    const task = /^\s*[-*+]\s+\[[ xX-]\]\s+(.+?)\s*$/u.exec(line.text);
    if (task) {
      matches.push({
        structure: "task",
        value: (task[1] ?? "").trim(),
        evidence: lineEvidence(content, line)
      });
    }

    const callout = /^\s*>\s*\[!([A-Za-z0-9_-]+)\](?:[+-])?(?:\s+.*)?$/u.exec(
      line.text
    );
    if (callout) {
      matches.push({
        structure: "callout",
        value: (callout[1] ?? "").toLocaleLowerCase(),
        evidence: lineEvidence(content, line)
      });
    }

    const nextLine = lines[index + 1];
    if (
      nextLine
      && line.text.includes("|")
      && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(
        nextLine.text
      )
    ) {
      matches.push({
        structure: "table",
        value: normalizeTableHeader(line.text),
        evidence: lineEvidence(content, line, nextLine)
      });
    }

    addInlineFormulaMatches(matches, content, formulaLine);
  }

  return matches;
}
