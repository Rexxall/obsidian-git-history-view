import { applyPatch, diffArrays, diffLines, diffWordsWithSpace, structuredPatch } from "diff";

const CONTEXT_LINE_COUNT = 3;
const COLLAPSE_THRESHOLD = 14;

export interface UnifiedDiffOptions {
  ignoreWhitespace: boolean;
  ignoreBlankLines?: boolean;
  onRestoreHunk?: (targetContent: string, hunkNumber: number) => void | Promise<void>;
  onLocateLine?: (line: number) => void | Promise<void>;
}

export interface SideBySideDiffOptions {
  ignoreWhitespace: boolean;
  ignoreBlankLines: boolean;
  changesOnly: boolean;
}

export interface HunkRestoreTarget {
  hunkNumber: number;
  currentStart: number;
  lines: string[];
  targetContent: string;
  currentBlock: string;
  historicalBlock: string;
}

export function buildHunkRestoreTargets(
  historicalText: string,
  currentText: string
): HunkRestoreTarget[] {
  const reversePatch = structuredPatch(
    "current",
    "historical",
    currentText,
    historicalText,
    "",
    "",
    { context: 3 }
  );
  const targets: HunkRestoreTarget[] = [];
  reversePatch.hunks.forEach((hunk, index) => {
    const targetContent = applyPatch(currentText, { ...reversePatch, hunks: [hunk] });
    if (targetContent === false) return;
    targets.push({
      hunkNumber: index + 1,
      currentStart: hunk.oldStart,
      lines: hunk.lines,
      targetContent,
      currentBlock: hunk.lines
        .filter((line) => !line.startsWith("+"))
        .map((line) => line.slice(1))
        .join("\n"),
      historicalBlock: hunk.lines
        .filter((line) => !line.startsWith("-"))
        .map((line) => line.slice(1))
        .join("\n")
    });
  });
  return targets;
}

function splitDisplayLines(value: string): string[] {
  const withoutFinalNewline = value.endsWith("\n") ? value.slice(0, -1) : value;
  return withoutFinalNewline === "" ? [""] : withoutFinalNewline.split(/\r?\n/);
}

function appendTextBlock(
  container: HTMLElement,
  value: string,
  className: string,
  changeIndex?: number
): void {
  const block = container.createEl("pre", { cls: `git-note-history-diff-block ${className}` });
  if (changeIndex !== undefined) {
    block.addClass("git-note-history-change-anchor");
    block.dataset.changeIndex = String(changeIndex);
    block.tabIndex = -1;
  }
  block.setText(value);
}

function renderNoChanges(
  container: HTMLElement,
  options: { ignoreWhitespace?: boolean; ignoreBlankLines?: boolean } = {}
): void {
  const empty = container.createDiv({ cls: "git-note-history-no-changes" });
  empty.createDiv({ cls: "git-note-history-no-changes-icon", text: "✓" });
  empty.createEl("h4", { text: "两个版本内容一致" });
  const ignored = [
    options.ignoreWhitespace ? "空格" : "",
    options.ignoreBlankLines ? "空行" : ""
  ].filter(Boolean).join("和");
  empty.createEl("p", {
    text: ignored
      ? `忽略${ignored}后没有检测到文本变化。可以切换到“双预览”查看完整内容。`
      : "没有需要审阅的文本变化。可以切换到“双预览”查看完整内容。"
  });
}

function comparableText(value: string, ignoreWhitespace: boolean): string {
  return ignoreWhitespace ? value.replace(/\s+/g, " ").trim() : value;
}

export function withoutBlankLines(value: string): string {
  const newline = value.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /\r?\n$/.test(value);
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (trailingNewline) lines.pop();
  const filtered = lines.filter((line) => line.trim() !== "");
  return `${filtered.join(newline)}${trailingNewline && filtered.length > 0 ? newline : ""}`;
}

function renderUnchangedBlock(container: HTMLElement, value: string): void {
  const lines = value.split("\n");
  if (lines.length <= COLLAPSE_THRESHOLD) {
    appendTextBlock(container, value, "is-unchanged");
    return;
  }

  const leading = lines.slice(0, CONTEXT_LINE_COUNT).join("\n") + "\n";
  const trailing = "\n" + lines.slice(-CONTEXT_LINE_COUNT).join("\n");
  const hidden = lines.slice(CONTEXT_LINE_COUNT, -CONTEXT_LINE_COUNT).join("\n");

  appendTextBlock(container, leading, "is-unchanged");
  const reveal = container.createEl("button", {
    cls: "git-note-history-diff-reveal",
    text: `展开 ${lines.length - CONTEXT_LINE_COUNT * 2} 行未修改内容`
  });
  appendTextBlock(container, trailing, "is-unchanged");

  reveal.addEventListener("click", () => {
    const expanded = reveal.ownerDocument.createElement("pre");
    expanded.className = "git-note-history-diff-block is-unchanged";
    expanded.setText(hidden);
    reveal.replaceWith(expanded);
  });
}

function renderHunkActions(
  container: HTMLElement,
  historicalText: string,
  currentText: string,
  options: UnifiedDiffOptions
): void {
  if (!options.onRestoreHunk && !options.onLocateLine) return;
  const targets = buildHunkRestoreTargets(historicalText, currentText);
  if (targets.length === 0) return;

  const section = container.createDiv({ cls: "git-note-history-hunks" });
  section.createEl("h6", { text: "局部恢复" });

  targets.forEach((target) => {
    const card = section.createDiv({ cls: "git-note-history-hunk" });
    const header = card.createDiv({ cls: "git-note-history-hunk-header" });
    header.createSpan({ text: `变更块 ${target.hunkNumber} · 当前第 ${target.currentStart} 行附近` });

    const actions = header.createDiv({ cls: "git-note-history-hunk-actions" });
    if (options.onLocateLine) {
      const locate = actions.createEl("button", { text: "定位" });
      locate.addEventListener("click", () => void options.onLocateLine?.(target.currentStart));
    }

    if (options.onRestoreHunk) {
      const restore = actions.createEl("button", { cls: "mod-warning", text: "恢复此块" });
      restore.addEventListener("click", () => void options.onRestoreHunk?.(target.targetContent, target.hunkNumber));
    }

    const copyCurrent = actions.createEl("button", { text: "复制当前块" });
    copyCurrent.addEventListener("click", () => void navigator.clipboard.writeText(target.currentBlock));
    const copyHistorical = actions.createEl("button", { text: "复制历史块" });
    copyHistorical.addEventListener("click", () => void navigator.clipboard.writeText(target.historicalBlock));

    const preview = card.createEl("pre", { cls: "git-note-history-hunk-preview" });
    preview.setText(target.lines.join("\n"));
  });
}

export function renderUnifiedDiff(
  container: HTMLElement,
  historicalText: string,
  currentText: string,
  options: UnifiedDiffOptions
): void {
  container.empty();
  const historicalDisplay = options.ignoreBlankLines ? withoutBlankLines(historicalText) : historicalText;
  const currentDisplay = options.ignoreBlankLines ? withoutBlankLines(currentText) : currentText;
  if (comparableText(historicalDisplay, options.ignoreWhitespace) === comparableText(currentDisplay, options.ignoreWhitespace)) {
    renderNoChanges(container, options);
    return;
  }
  container.createDiv({
    cls: "git-note-history-diff-legend",
    text: "− 历史版本内容　＋当前版本内容；颜色之外同时保留符号提示"
  });

  let changeIndex = 0;
  let insideChange = false;
  for (const part of diffLines(historicalDisplay, currentDisplay, {
    ignoreWhitespace: options.ignoreWhitespace
  })) {
    if (part.added || part.removed) {
      const firstInChange = !insideChange;
      if (firstInChange) changeIndex += 1;
      insideChange = true;
      appendTextBlock(
        container,
        part.value,
        part.added ? "is-added" : "is-removed",
        firstInChange ? changeIndex : undefined
      );
    } else {
      insideChange = false;
      renderUnchangedBlock(container, part.value);
    }
  }

  if (!options.ignoreBlankLines) {
    renderHunkActions(container, historicalText, currentText, options);
  }
}

function renderWordLine(
  container: HTMLElement,
  oldLine: string,
  newLine: string,
  side: "old" | "new"
): void {
  for (const part of diffWordsWithSpace(oldLine, newLine)) {
    if (side === "old" && part.added) continue;
    if (side === "new" && part.removed) continue;
    const span = container.createSpan({ text: part.value });
    if (side === "old" && part.removed) span.addClass("is-word-removed");
    if (side === "new" && part.added) span.addClass("is-word-added");
  }
}

export interface SideRow {
  oldLineNumber: number | null;
  oldText: string;
  newLineNumber: number | null;
  newText: string;
  kind: "same" | "changed" | "old" | "new";
  changeIndex?: number;
}

export type FocusedSideItem =
  | { kind: "row"; row: SideRow }
  | { kind: "omitted"; count: number };

interface SourceLine {
  lineNumber: number;
  text: string;
}

function sourceLines(value: string, ignoreBlankLines: boolean): SourceLine[] {
  return splitDisplayLines(value)
    .map((text, index) => ({ lineNumber: index + 1, text }))
    .filter((line) => !ignoreBlankLines || line.text.trim() !== "");
}

export function buildSideRows(
  oldText: string,
  newText: string,
  options: Pick<SideBySideDiffOptions, "ignoreWhitespace" | "ignoreBlankLines">
): SideRow[] {
  const oldLines = sourceLines(oldText, options.ignoreBlankLines);
  const newLines = sourceLines(newText, options.ignoreBlankLines);
  const parts = diffArrays(
    oldLines,
    newLines,
    {
      comparator: (oldLine, newLine) =>
        comparableText(oldLine.text, options.ignoreWhitespace)
          === comparableText(newLine.text, options.ignoreWhitespace)
    }
  );
  const rows: SideRow[] = [];
  let changeIndex = 0;
  let oldOffset = 0;
  let newOffset = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (!part.added && !part.removed) {
      for (let lineIndex = 0; lineIndex < part.value.length; lineIndex += 1) {
        const oldLine = oldLines[oldOffset + lineIndex]!;
        const newLine = newLines[newOffset + lineIndex]!;
        rows.push({
          oldLineNumber: oldLine.lineNumber,
          oldText: oldLine.text,
          newLineNumber: newLine.lineNumber,
          newText: newLine.text,
          kind: "same"
        });
      }
      oldOffset += part.value.length;
      newOffset += part.value.length;
      continue;
    }

    if (part.removed && parts[index + 1]?.added) {
      changeIndex += 1;
      const oldLines = part.value;
      const addedPart = parts[index + 1];
      const newLines = addedPart?.value ?? [];
      const count = Math.max(oldLines.length, newLines.length);
      for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
        const oldValue = oldLines[rowIndex];
        const newValue = newLines[rowIndex];
        rows.push({
          oldLineNumber: oldValue?.lineNumber ?? null,
          oldText: oldValue?.text ?? "",
          newLineNumber: newValue?.lineNumber ?? null,
          newText: newValue?.text ?? "",
          kind: "changed",
          changeIndex
        });
      }
      oldOffset += oldLines.length;
      newOffset += newLines.length;
      index += 1;
      continue;
    }

    changeIndex += 1;
    for (const line of part.value) {
      if (part.removed) {
        rows.push({
          oldLineNumber: line.lineNumber,
          oldText: line.text,
          newLineNumber: null,
          newText: "",
          kind: "old",
          changeIndex
        });
      } else {
        rows.push({
          oldLineNumber: null,
          oldText: "",
          newLineNumber: line.lineNumber,
          newText: line.text,
          kind: "new",
          changeIndex
        });
      }
    }
    if (part.removed) oldOffset += part.value.length;
    else newOffset += part.value.length;
  }
  return rows;
}

export function buildFocusedSideItems(rows: SideRow[]): FocusedSideItem[] {
  const items: FocusedSideItem[] = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index]?.kind !== "same") {
      items.push({ kind: "row", row: rows[index]! });
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end]?.kind === "same") end += 1;
    if (index > 0 && end < rows.length) {
      items.push({ kind: "omitted", count: end - index });
    }
    index = end;
  }
  return items;
}

export function renderSideBySideDiff(
  container: HTMLElement,
  oldText: string,
  newText: string,
  options: SideBySideDiffOptions
): void {
  container.empty();
  const rows = buildSideRows(oldText, newText, options);
  if (rows.every((row) => row.kind === "same")) {
    renderNoChanges(container, options);
    return;
  }
  const grid = container.createDiv({ cls: "git-note-history-side-grid" });
  const renderedAnchors = new Set<number>();

  const renderRow = (row: SideRow) => {
    grid.createDiv({
      cls: `git-note-history-line-number is-${row.kind} is-base-side`,
      text: row.oldLineNumber?.toString() ?? ""
    });
    const oldCell = grid.createDiv({
      cls: `git-note-history-side-line is-${row.kind} is-base-side`
    });
    grid.createDiv({
      cls: `git-note-history-line-number is-${row.kind} is-target-side`,
      text: row.newLineNumber?.toString() ?? ""
    });
    const newCell = grid.createDiv({
      cls: `git-note-history-side-line is-${row.kind} is-target-side`
    });
    if (row.changeIndex !== undefined && !renderedAnchors.has(row.changeIndex)) {
      renderedAnchors.add(row.changeIndex);
      oldCell.addClass("git-note-history-change-anchor");
      oldCell.dataset.changeIndex = String(row.changeIndex);
      oldCell.tabIndex = -1;
    }

    if (row.kind === "changed") {
      renderWordLine(oldCell, row.oldText, row.newText, "old");
      renderWordLine(newCell, row.oldText, row.newText, "new");
    } else {
      oldCell.setText(row.oldText);
      newCell.setText(row.newText);
    }
  };

  const renderOmitted = (count: number): void => {
    grid.createDiv({
      cls: "git-note-history-side-omitted",
      text: `⋯ ${count} 行未变`
    });
  };

  const renderRows = (collapseUnchanged: boolean) => {
    grid.empty();
    renderedAnchors.clear();
    if (options.changesOnly) {
      for (const item of buildFocusedSideItems(rows)) {
        if (item.kind === "omitted") renderOmitted(item.count);
        else renderRow(item.row);
      }
      return;
    }
    for (let index = 0; index < rows.length;) {
      if (!collapseUnchanged || rows[index]?.kind !== "same") {
        renderRow(rows[index]!);
        index += 1;
        continue;
      }
      let end = index;
      while (end < rows.length && rows[end]?.kind === "same") end += 1;
      const runLength = end - index;
      if (runLength <= COLLAPSE_THRESHOLD) {
        for (let cursor = index; cursor < end; cursor += 1) renderRow(rows[cursor]!);
      } else {
        for (let cursor = index; cursor < index + CONTEXT_LINE_COUNT; cursor += 1) renderRow(rows[cursor]!);
        const reveal = grid.createEl("button", {
          cls: "git-note-history-side-reveal",
          text: `⋯ ${runLength - CONTEXT_LINE_COUNT * 2} 行未变`,
          attr: {
            "aria-label": `展开 ${runLength - CONTEXT_LINE_COUNT * 2} 行未修改内容`
          }
        });
        reveal.addEventListener("click", () => renderRows(false));
        for (let cursor = end - CONTEXT_LINE_COUNT; cursor < end; cursor += 1) renderRow(rows[cursor]!);
      }
      index = end;
    }
  };
  renderRows(true);
}

export function renderTextDiff(container: HTMLElement, oldText: string, newText: string): void {
  renderUnifiedDiff(container, oldText, newText, { ignoreWhitespace: false });
}
