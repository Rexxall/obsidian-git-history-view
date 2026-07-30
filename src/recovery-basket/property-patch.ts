import type { RecoveryBasketSource } from "./types";
import {
  createRecoveryBasketItem,
  createRecoveryPatches
} from "./planner";

interface FrontmatterPropertyBlock {
  name: string;
  start: number;
  end: number;
  lines: string[];
}

interface ParsedFrontmatter {
  lines: string[];
  newline: "\n" | "\r\n";
  trailingNewline: boolean;
  closingIndex: number | null;
  properties: Map<string, FrontmatterPropertyBlock>;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  const properties = new Map<string, FrontmatterPropertyBlock>();
  if (lines[0]?.trim() !== "---") {
    return { lines, newline, trailingNewline, closingIndex: null, properties };
  }
  const closingOffset = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingOffset < 0) {
    return { lines, newline, trailingNewline, closingIndex: null, properties };
  }
  const closingIndex = closingOffset + 1;
  let current: { name: string; start: number } | null = null;
  const flush = (end: number): void => {
    if (!current) return;
    properties.set(current.name, {
      name: current.name,
      start: current.start,
      end,
      lines: lines.slice(current.start, end)
    });
  };
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([^#\s][^:]*):(?:\s*.*)?$/.exec(line);
    if (!match?.[1]) continue;
    flush(index);
    current = { name: match[1].trim(), start: index };
  }
  flush(closingIndex);
  return { lines, newline, trailingNewline, closingIndex, properties };
}

function joinContent(parsed: ParsedFrontmatter, lines: string[]): string {
  return `${lines.join(parsed.newline)}${parsed.trailingNewline ? parsed.newline : ""}`;
}

function preview(lines: readonly string[]): string {
  const text = lines.join("\n").trim();
  return text.length > 320 ? `${text.slice(0, 319)}…` : text || "无";
}

export function createPropertyRecoveryItem(options: {
  filePath: string;
  propertyName: string;
  historicalContent: string;
  currentContent: string;
  source: RecoveryBasketSource;
  id?: string;
  addedAt?: string;
}) {
  const historical = parseFrontmatter(options.historicalContent);
  const current = parseFrontmatter(options.currentContent);
  const historicalBlock = historical.properties.get(options.propertyName);
  const currentBlock = current.properties.get(options.propertyName);
  if (!historicalBlock && !currentBlock) {
    throw new Error(`两个版本都没有属性“${options.propertyName}”。`);
  }

  let targetLines = [...current.lines];
  if (currentBlock && historicalBlock) {
    targetLines.splice(
      currentBlock.start,
      currentBlock.end - currentBlock.start,
      ...historicalBlock.lines
    );
  } else if (currentBlock) {
    targetLines.splice(currentBlock.start, currentBlock.end - currentBlock.start);
  } else if (historicalBlock && current.closingIndex !== null) {
    targetLines.splice(current.closingIndex, 0, ...historicalBlock.lines);
  } else if (historicalBlock) {
    targetLines = ["---", ...historicalBlock.lines, "---", ...targetLines];
  }

  const targetContent = joinContent(current, targetLines);
  const patches = createRecoveryPatches(options.currentContent, targetContent);
  if (patches.length === 0) {
    throw new Error(`当前属性“${options.propertyName}”已经与历史版本相同。`);
  }
  return createRecoveryBasketItem({
    filePath: options.filePath,
    kind: "property",
    label: `恢复属性 ${options.propertyName}`,
    source: options.source,
    patches,
    previewBefore: preview(currentBlock?.lines ?? []),
    previewAfter: preview(historicalBlock?.lines ?? []),
    propertyNames: [options.propertyName],
    ...(options.id ? { id: options.id } : {}),
    ...(options.addedAt ? { addedAt: options.addedAt } : {})
  });
}
