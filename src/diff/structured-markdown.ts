import { diffArrays } from "diff";

export type SemanticGroup =
  | "属性"
  | "标题"
  | "段落"
  | "列表"
  | "任务"
  | "表格"
  | "Callout"
  | "代码"
  | "公式"
  | "链接";

export type SemanticChangeKind = "added" | "removed" | "changed" | "moved";

export interface SemanticChangeDetail {
  label: string;
  before?: string;
  after?: string;
}

export interface SemanticChange {
  group: SemanticGroup;
  kind: SemanticChangeKind;
  label: string;
  before?: string;
  after?: string;
  beforeLine?: number;
  afterLine?: number;
  beforeContext?: string;
  afterContext?: string;
  details?: SemanticChangeDetail[];
}

export interface SemanticDiffOptions {
  ignoreFrontmatter?: boolean;
}

interface TableData {
  headers: string[];
  rows: string[][];
}

interface SemanticEntity {
  group: Exclude<SemanticGroup, "属性" | "链接">;
  label: string;
  identity: string;
  value: string;
  display: string;
  line: number;
  context: string;
  table?: TableData;
}

const GROUP_ORDER: SemanticGroup[] = [
  "属性",
  "标题",
  "段落",
  "列表",
  "任务",
  "表格",
  "Callout",
  "代码",
  "公式",
  "链接"
];

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, "$2 $1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function preview(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function contextLabel(headings: string[]): string {
  return headings.length > 0 ? headings.join(" / ") : "文档开头";
}

function parseFrontmatterProperties(lines: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (lines[0]?.trim() !== "---") return result;
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) return result;

  let currentName = "";
  let currentLines: string[] = [];
  const flush = (): void => {
    if (!currentName) return;
    result.set(currentName, currentLines.join("\n").trim());
  };

  for (const line of lines.slice(1, end + 1)) {
    const property = /^([^#\s][^:]*):(?:\s*(.*))?$/.exec(line);
    if (property?.[1]) {
      flush();
      currentName = property[1].trim();
      currentLines = property[2] ? [property[2]] : [];
    } else if (currentName && (line.trim() !== "" || currentLines.length > 0)) {
      currentLines.push(line.trimEnd());
    }
  }
  flush();
  return result;
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  return end < 0 ? 0 : end + 2;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      current += character;
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? "";
  const separator = lines[index + 1] ?? "";
  if (!header.includes("|")) return false;
  const cells = splitTableRow(separator);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isListLine(line: string): boolean {
  return /^(\s*)([-+*]|\d+[.)])\s+(?:\[[ xX-]\]\s+)?(.+)$/.test(line);
}

function isCalloutLine(line: string): boolean {
  return /^\s*>\s*\[![^\]]+\][+-]?\s*/.test(line);
}

function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function isMathFence(line: string): boolean {
  return line.trim().startsWith("$$");
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}

function isSpecialStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return isHeadingLine(line)
    || isFenceLine(line)
    || isMathFence(line)
    || isCalloutLine(line)
    || isListLine(line)
    || isTableStart(lines, index);
}

function extractEntities(text: string): SemanticEntity[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const entities: SemanticEntity[] = [];
  const headings: string[] = [];
  let index = frontmatterEnd(lines);

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length;
      const title = heading[2].trim();
      headings.splice(level - 1);
      const parent = contextLabel(headings.filter(Boolean));
      headings[level - 1] = title;
      entities.push({
        group: "标题",
        label: title,
        identity: normalizeText(title),
        value: `H${level}`,
        display: `H${level} · ${title}`,
        line: index + 1,
        context: parent
      });
      index += 1;
      continue;
    }

    const fence = /^\s*(```|~~~)\s*([^\s`]*)/.exec(line);
    if (fence?.[1]) {
      const marker = fence[1];
      const language = (fence[2] ?? "").toLocaleLowerCase();
      const start = index;
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith(marker)) {
        index += 1;
      }
      const body = lines.slice(start + 1, index).join("\n").trim();
      if (index < lines.length) index += 1;
      const mermaid = language === "mermaid";
      entities.push({
        group: "代码",
        label: mermaid ? "Mermaid 图" : language ? `代码块 · ${language}` : "代码块",
        identity: mermaid ? "mermaid" : `code:${language || "plain"}`,
        value: body,
        display: body ? preview(body) : "空代码块",
        line: start + 1,
        context: contextLabel(headings.filter(Boolean))
      });
      continue;
    }

    if (isMathFence(line)) {
      const start = index;
      const inlineClosing = line.trim().length > 2 && line.trim().endsWith("$$");
      if (inlineClosing) {
        index += 1;
      } else {
        index += 1;
        while (index < lines.length && !(lines[index] ?? "").trim().endsWith("$$")) index += 1;
        if (index < lines.length) index += 1;
      }
      const content = lines.slice(start, index).join("\n")
        .replace(/^\s*\$\$/, "")
        .replace(/\$\$\s*$/, "")
        .trim();
      entities.push({
        group: "公式",
        label: "块级公式",
        identity: "math",
        value: content,
        display: content ? preview(content) : "空公式",
        line: start + 1,
        context: contextLabel(headings.filter(Boolean))
      });
      continue;
    }

    const callout = /^\s*>\s*\[!([^\]]+)\]([+-])?\s*(.*)$/.exec(line);
    if (callout?.[1]) {
      const start = index;
      const type = callout[1].toLocaleUpperCase();
      const title = callout[3]?.trim() || type;
      index += 1;
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) index += 1;
      const body = lines.slice(start + 1, index)
        .map((value) => value.replace(/^\s*>\s?/, ""))
        .join("\n")
        .trim();
      entities.push({
        group: "Callout",
        label: `${type} · ${title}`,
        identity: `callout:${normalizeText(title)}`,
        value: `${type}|${callout[2] ?? ""}|${body}`,
        display: body ? `${type} · ${title}：${preview(body)}` : `${type} · ${title}`,
        line: start + 1,
        context: contextLabel(headings.filter(Boolean))
      });
      continue;
    }

    if (isTableStart(lines, index)) {
      const start = index;
      const headers = splitTableRow(lines[index] ?? "");
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim() !== "") {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      const table: TableData = { headers, rows };
      const heading = headings.filter(Boolean).at(-1);
      entities.push({
        group: "表格",
        label: heading ? `表格 · ${heading}` : `表格 · ${headers.join(" / ")}`,
        identity: `table:${normalizeText(headers.join("|"))}`,
        value: JSON.stringify(table),
        display: `${headers.length} 列 · ${rows.length} 行`,
        line: start + 1,
        context: contextLabel(headings.filter(Boolean)),
        table
      });
      continue;
    }

    const list = /^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX-])\]\s+)?(.+)$/.exec(line);
    if (list?.[2] && list[4]) {
      const depth = Math.floor((list[1]?.replace(/\t/g, "  ").length ?? 0) / 2);
      const text = list[4].trim();
      const taskState = list[3];
      const group = taskState === undefined ? "列表" : "任务";
      const status = taskState === undefined
        ? (/^\d/.test(list[2]) ? "有序列表" : "无序列表")
        : /[xX]/.test(taskState) ? "已完成" : taskState === "-" ? "进行中" : "待办";
      entities.push({
        group,
        label: text,
        identity: normalizeText(text),
        value: `${status}|depth:${depth}`,
        display: `${status} · ${text}`,
        line: index + 1,
        context: contextLabel(headings.filter(Boolean))
      });
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (
      index < lines.length
      && (lines[index] ?? "").trim() !== ""
      && !isSpecialStart(lines, index)
    ) {
      index += 1;
    }
    const content = lines.slice(start, index).join("\n").trim();
    if (content) {
      entities.push({
        group: "段落",
        label: preview(content, 72),
        identity: normalizeText(content),
        value: normalizeText(content),
        display: preview(content),
        line: start + 1,
        context: contextLabel(headings.filter(Boolean))
      });
    }
  }

  return entities;
}

function tableDetails(before: TableData | undefined, after: TableData | undefined): SemanticChangeDetail[] {
  if (!before || !after) return [];
  const details: SemanticChangeDetail[] = [];
  const rowCount = Math.max(before.rows.length, after.rows.length);
  const columnCount = Math.max(before.headers.length, after.headers.length);
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const beforeValue = before.rows[row]?.[column];
      const afterValue = after.rows[row]?.[column];
      if (beforeValue === afterValue) continue;
      const header = after.headers[column] ?? before.headers[column] ?? `第 ${column + 1} 列`;
      const detail: SemanticChangeDetail = { label: `第 ${row + 1} 行 · ${header}` };
      if (beforeValue !== undefined) detail.before = beforeValue;
      if (afterValue !== undefined) detail.after = afterValue;
      details.push(detail);
    }
  }
  return details;
}

function similarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeText(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalizeText(right).split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function changedEntity(
  before: SemanticEntity,
  after: SemanticEntity,
  kind: Extract<SemanticChangeKind, "changed" | "moved">
): SemanticChange {
  const change: SemanticChange = {
    group: after.group,
    kind,
    label: after.label || before.label,
    before: before.display,
    after: after.display,
    beforeLine: before.line,
    afterLine: after.line,
    beforeContext: before.context,
    afterContext: after.context
  };
  if (after.group === "表格") {
    const details = tableDetails(before.table, after.table);
    if (details.length > 0) change.details = details;
  }
  return change;
}

function pairRemovedAndAdded(
  removed: SemanticEntity[],
  added: SemanticEntity[]
): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const usedAdded = new Set<number>();
  const usedRemoved = new Set<number>();

  const findAdded = (
    before: SemanticEntity,
    predicate: (after: SemanticEntity) => boolean
  ): number => {
    for (let index = 0; index < added.length; index += 1) {
      if (usedAdded.has(index)) continue;
      const after = added[index]!;
      if (after.group === before.group && predicate(after)) return index;
    }
    return -1;
  };

  for (let index = 0; index < removed.length; index += 1) {
    const before = removed[index]!;
    const addedIndex = findAdded(
      before,
      (after) => after.identity === before.identity && after.value === before.value
    );
    if (addedIndex < 0) continue;
    usedRemoved.add(index);
    usedAdded.add(addedIndex);
    changes.push(changedEntity(before, added[addedIndex]!, "moved"));
  }

  for (let index = 0; index < removed.length; index += 1) {
    if (usedRemoved.has(index)) continue;
    const before = removed[index]!;
    const addedIndex = findAdded(before, (after) => after.identity === before.identity);
    if (addedIndex < 0) continue;
    usedRemoved.add(index);
    usedAdded.add(addedIndex);
    changes.push(changedEntity(before, added[addedIndex]!, "changed"));
  }

  for (let index = 0; index < removed.length; index += 1) {
    if (usedRemoved.has(index)) continue;
    const before = removed[index]!;
    let bestIndex = -1;
    let bestScore = 0;
    for (let candidate = 0; candidate < added.length; candidate += 1) {
      if (usedAdded.has(candidate)) continue;
      const after = added[candidate]!;
      if (after.group !== before.group) continue;
      const textScore = similarity(before.display, after.display);
      const contextBonus = before.context === after.context ? 0.25 : 0;
      const positionBonus = Math.max(0, 0.25 - Math.abs(before.line - after.line) / 200);
      const score = textScore + contextBonus + positionBonus;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = candidate;
      }
    }
    const threshold = before.group === "段落" ? 0.48 : 0.3;
    if (bestIndex < 0 || bestScore < threshold) continue;
    usedRemoved.add(index);
    usedAdded.add(bestIndex);
    changes.push(changedEntity(before, added[bestIndex]!, "changed"));
  }

  for (let index = 0; index < removed.length; index += 1) {
    if (usedRemoved.has(index)) continue;
    const entity = removed[index]!;
    changes.push({
      group: entity.group,
      kind: "removed",
      label: entity.label,
      before: entity.display,
      beforeLine: entity.line,
      beforeContext: entity.context
    });
  }
  for (let index = 0; index < added.length; index += 1) {
    if (usedAdded.has(index)) continue;
    const entity = added[index]!;
    changes.push({
      group: entity.group,
      kind: "added",
      label: entity.label,
      after: entity.display,
      afterLine: entity.line,
      afterContext: entity.context
    });
  }
  return changes;
}

function structuralChanges(beforeText: string, afterText: string): SemanticChange[] {
  const before = extractEntities(beforeText);
  const after = extractEntities(afterText);
  const parts = diffArrays(before, after, {
    comparator: (left, right) =>
      left.group === right.group
      && left.identity === right.identity
      && left.value === right.value
  });
  const removed = parts.filter((part) => part.removed).flatMap((part) => part.value);
  const added = parts.filter((part) => part.added).flatMap((part) => part.value);
  return pairRemovedAndAdded(removed, added);
}

function propertyChanges(beforeText: string, afterText: string): SemanticChange[] {
  const before = parseFrontmatterProperties(beforeText.replace(/\r\n/g, "\n").split("\n"));
  const after = parseFrontmatterProperties(afterText.replace(/\r\n/g, "\n").split("\n"));
  const changes: SemanticChange[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const beforeValue = before.get(name);
    const afterValue = after.get(name);
    if (beforeValue === afterValue) continue;
    const change: SemanticChange = {
      group: "属性",
      kind: beforeValue === undefined ? "added" : afterValue === undefined ? "removed" : "changed",
      label: name
    };
    if (beforeValue !== undefined) change.before = beforeValue || "空值";
    if (afterValue !== undefined) change.after = afterValue || "空值";
    changes.push(change);
  }
  return changes;
}

function linkTargets(text: string): Set<string> {
  const targets = new Set<string>();
  for (const match of text.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    const target = match[1]?.split("|")[0]?.split("#")[0]?.trim();
    if (target) targets.add(target);
  }
  return targets;
}

function linkChanges(beforeText: string, afterText: string): SemanticChange[] {
  const before = linkTargets(beforeText);
  const after = linkTargets(afterText);
  const changes: SemanticChange[] = [];
  for (const target of before) {
    if (!after.has(target)) changes.push({ group: "链接", kind: "removed", label: target });
  }
  for (const target of after) {
    if (!before.has(target)) changes.push({ group: "链接", kind: "added", label: target });
  }
  return changes;
}

export function buildStructuredMarkdownDiff(
  beforeText: string,
  afterText: string,
  options: SemanticDiffOptions = {}
): SemanticChange[] {
  const changes = [
    ...(options.ignoreFrontmatter ? [] : propertyChanges(beforeText, afterText)),
    ...structuralChanges(beforeText, afterText),
    ...linkChanges(beforeText, afterText)
  ];
  return changes.sort((left, right) => {
    const groupOrder = GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group);
    if (groupOrder !== 0) return groupOrder;
    return (left.afterLine ?? left.beforeLine ?? 0) - (right.afterLine ?? right.beforeLine ?? 0);
  });
}

export function semanticGroupOrder(): readonly SemanticGroup[] {
  return GROUP_ORDER;
}
