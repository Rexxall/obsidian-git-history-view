import { applyPatch, diffLines, diffWordsWithSpace, structuredPatch } from "diff";

const CONTEXT_LINE_COUNT = 3;
const COLLAPSE_THRESHOLD = 14;

export interface UnifiedDiffOptions {
  ignoreWhitespace: boolean;
  onRestoreHunk?: (targetContent: string, hunkNumber: number) => void | Promise<void>;
  onLocateLine?: (line: number) => void | Promise<void>;
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

function renderNoChanges(container: HTMLElement, ignoreWhitespace = false): void {
  const empty = container.createDiv({ cls: "git-note-history-no-changes" });
  empty.createDiv({ cls: "git-note-history-no-changes-icon", text: "✓" });
  empty.createEl("h4", { text: "两个版本内容一致" });
  empty.createEl("p", {
    text: ignoreWhitespace
      ? "忽略空格后没有检测到文本变化。可以切换到“预览”查看完整内容。"
      : "没有需要审阅的文本变化。可以切换到“预览”查看完整内容。"
  });
}

function comparableText(value: string, ignoreWhitespace: boolean): string {
  return ignoreWhitespace ? value.replace(/\s+/g, " ").trim() : value;
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
  if (comparableText(historicalText, options.ignoreWhitespace) === comparableText(currentText, options.ignoreWhitespace)) {
    renderNoChanges(container, options.ignoreWhitespace);
    return;
  }
  container.createDiv({
    cls: "git-note-history-diff-legend",
    text: "− 历史版本内容　＋当前版本内容；颜色之外同时保留符号提示"
  });

  let changeIndex = 0;
  let insideChange = false;
  for (const part of diffLines(historicalText, currentText, {
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

  renderHunkActions(container, historicalText, currentText, options);
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

interface SideRow {
  oldLineNumber: number | null;
  oldText: string;
  newLineNumber: number | null;
  newText: string;
  kind: "same" | "changed" | "old" | "new";
  changeIndex?: number;
}

function buildSideRows(oldText: string, newText: string, ignoreWhitespace: boolean): SideRow[] {
  const parts = diffLines(oldText, newText, { ignoreWhitespace });
  const rows: SideRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let changeIndex = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (!part.added && !part.removed) {
      for (const line of splitDisplayLines(part.value)) {
        rows.push({ oldLineNumber: oldLine++, oldText: line, newLineNumber: newLine++, newText: line, kind: "same" });
      }
      continue;
    }

    if (part.removed && parts[index + 1]?.added) {
      changeIndex += 1;
      const oldLines = splitDisplayLines(part.value);
      const addedPart = parts[index + 1];
      const newLines = splitDisplayLines(addedPart?.value ?? "");
      const count = Math.max(oldLines.length, newLines.length);
      for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
        const oldValue = oldLines[rowIndex];
        const newValue = newLines[rowIndex];
        rows.push({
          oldLineNumber: oldValue === undefined ? null : oldLine++,
          oldText: oldValue ?? "",
          newLineNumber: newValue === undefined ? null : newLine++,
          newText: newValue ?? "",
          kind: "changed",
          changeIndex
        });
      }
      index += 1;
      continue;
    }

    const lines = splitDisplayLines(part.value);
    changeIndex += 1;
    for (const line of lines) {
      if (part.removed) {
        rows.push({ oldLineNumber: oldLine++, oldText: line, newLineNumber: null, newText: "", kind: "old", changeIndex });
      } else {
        rows.push({ oldLineNumber: null, oldText: "", newLineNumber: newLine++, newText: line, kind: "new", changeIndex });
      }
    }
  }
  return rows;
}

export function renderSideBySideDiff(
  container: HTMLElement,
  oldText: string,
  newText: string,
  ignoreWhitespace: boolean
): void {
  container.empty();
  if (comparableText(oldText, ignoreWhitespace) === comparableText(newText, ignoreWhitespace)) {
    renderNoChanges(container, ignoreWhitespace);
    return;
  }
  const grid = container.createDiv({ cls: "git-note-history-side-grid" });
  const rows = buildSideRows(oldText, newText, ignoreWhitespace);
  const renderedAnchors = new Set<number>();

  const renderRow = (row: SideRow) => {
    grid.createDiv({ cls: `git-note-history-line-number is-${row.kind}`, text: row.oldLineNumber?.toString() ?? "" });
    const oldCell = grid.createDiv({ cls: `git-note-history-side-line is-${row.kind}` });
    grid.createDiv({ cls: `git-note-history-line-number is-${row.kind}`, text: row.newLineNumber?.toString() ?? "" });
    const newCell = grid.createDiv({ cls: `git-note-history-side-line is-${row.kind}` });
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

  const renderRows = (collapseUnchanged: boolean) => {
    grid.empty();
    renderedAnchors.clear();
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
          text: `展开 ${runLength - CONTEXT_LINE_COUNT * 2} 行未修改内容`
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
