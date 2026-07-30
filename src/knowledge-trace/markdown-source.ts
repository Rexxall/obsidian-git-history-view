import { parseYaml } from "obsidian";
import type { KnowledgeAssertionEvidence } from "./types";

export type FrontmatterInspection =
  | {
      state: "absent";
      bodyStart: 0;
      body: string;
    }
  | {
      state: "ready";
      bodyStart: number;
      body: string;
      raw: string;
      properties: Readonly<Record<string, unknown>>;
    }
  | {
      state: "invalid";
      bodyStart: number;
      body: string;
      raw: string;
      error: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "YAML 解析失败。";
}

export function inspectFrontmatter(content: string): FrontmatterInspection {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/u.exec(content);
  if (!opening) {
    return { state: "absent", bodyStart: 0, body: content };
  }

  const rawStart = opening[0].length;
  const closingPattern = /^(?:---|\.\.\.)[ \t]*\r?$/gmu;
  closingPattern.lastIndex = rawStart;
  const closing = closingPattern.exec(content);
  if (!closing || closing.index < rawStart) {
    return {
      state: "invalid",
      bodyStart: content.length,
      body: "",
      raw: content.slice(rawStart),
      error: "Frontmatter 缺少结束分隔线。"
    };
  }

  let bodyStart = closing.index + closing[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  const raw = content.slice(rawStart, closing.index).replace(/\r?\n$/u, "");

  try {
    const parsed: unknown = raw.trim() ? parseYaml(raw) : {};
    if (
      parsed === null
      || typeof parsed !== "object"
      || Array.isArray(parsed)
    ) {
      return {
        state: "invalid",
        bodyStart,
        body: content.slice(bodyStart),
        raw,
        error: "Frontmatter 顶层必须是属性对象。"
      };
    }
    return {
      state: "ready",
      bodyStart,
      body: content.slice(bodyStart),
      raw,
      properties: parsed as Readonly<Record<string, unknown>>
    };
  } catch (error) {
    return {
      state: "invalid",
      bodyStart,
      body: content.slice(bodyStart),
      raw,
      error: errorMessage(error)
    };
  }
}

export function evidenceFromRange(
  content: string,
  start: number,
  end: number
): KnowledgeAssertionEvidence {
  const safeStart = Math.max(0, Math.min(start, content.length));
  const safeEnd = Math.max(safeStart, Math.min(end, content.length));
  const context = 48;
  const maxSelectedCharacters = 320;
  const excerptSelectionEnd = Math.min(
    safeEnd,
    safeStart + maxSelectedCharacters
  );
  const excerptStart = Math.max(0, safeStart - context);
  const excerptEnd = Math.min(
    content.length,
    excerptSelectionEnd + context
  );
  const clipped = excerptSelectionEnd < safeEnd;
  return {
    start: safeStart,
    end: safeEnd,
    excerpt: `${content.slice(excerptStart, excerptEnd)}${clipped ? "…" : ""}`
  };
}

export function firstTextEvidence(
  content: string,
  query: string,
  caseSensitive = true
): KnowledgeAssertionEvidence | undefined {
  if (!query) return undefined;
  const haystack = caseSensitive ? content : content.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const start = haystack.indexOf(needle);
  return start >= 0
    ? evidenceFromRange(content, start, start + query.length)
    : undefined;
}

function maskRange(
  characters: string[],
  start: number,
  end: number
): void {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") {
      characters[index] = " ";
    }
  }
}

/**
 * Replaces Markdown literal/comment regions with spaces while preserving every
 * source offset. Relation parsing can then ignore examples and comments
 * without losing the original evidence coordinates.
 */
export function maskMarkdownRelationLiterals(content: string): string {
  const characters = content.split("");

  for (const comment of content.matchAll(/<!--[\s\S]*?(?:-->|$)/gu)) {
    maskRange(
      characters,
      comment.index,
      comment.index + comment[0].length
    );
  }

  let fence: { character: "`" | "~"; length: number } | null = null;
  let lineStart = 0;
  while (lineStart < content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? content.length : newline + 1;
    const line = content.slice(lineStart, lineEnd).replace(/\r?\n$/u, "");
    if (fence) {
      maskRange(characters, lineStart, lineEnd);
      const closing = new RegExp(
        `^\\s*${fence.character === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
        "u"
      );
      if (closing.test(line)) fence = null;
    } else {
      const opening = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
      const marker = opening?.[1];
      if (marker) {
        const character = marker[0];
        if (character === "`" || character === "~") {
          fence = { character, length: marker.length };
          maskRange(characters, lineStart, lineEnd);
        }
      }
    }
    lineStart = lineEnd;
  }

  for (const code of content.matchAll(/(`+)([^`\n]*?)\1/gu)) {
    maskRange(characters, code.index, code.index + code[0].length);
  }
  return characters.join("");
}
