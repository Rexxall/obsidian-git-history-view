import {
  buildStructuredMarkdownDiff,
  semanticGroupOrder,
  type SemanticChange,
  type SemanticChangeKind,
  type SemanticDiffOptions
} from "./structured-markdown";

export type {
  SemanticChange,
  SemanticChangeDetail,
  SemanticChangeKind,
  SemanticDiffOptions,
  SemanticGroup
} from "./structured-markdown";

const KIND_LABELS: Record<SemanticChangeKind, string> = {
  added: "新增",
  removed: "删除",
  changed: "修改",
  moved: "移动"
};

const KIND_SYMBOLS: Record<SemanticChangeKind, string> = {
  added: "+",
  removed: "−",
  changed: "↔",
  moved: "↕"
};

export interface SemanticDiffRenderOptions {
  onAddPropertyToBasket?: (
    propertyName: string,
    change: SemanticChange
  ) => void | Promise<void>;
}

export function buildSemanticDiff(
  beforeText: string,
  afterText: string,
  options: SemanticDiffOptions = {}
): SemanticChange[] {
  return buildStructuredMarkdownDiff(beforeText, afterText, options);
}

function renderLocation(container: HTMLElement, change: SemanticChange): void {
  const location = container.createDiv({ cls: "git-note-history-semantic-location" });
  if (change.kind === "moved") {
    location.createSpan({
      text: `${change.beforeContext ?? "原位置"} → ${change.afterContext ?? "新位置"}`
    });
    return;
  }
  const line = change.afterLine ?? change.beforeLine;
  const context = change.afterContext ?? change.beforeContext;
  if (context) location.createSpan({ text: context });
  if (line !== undefined) location.createSpan({ text: `第 ${line} 行` });
}

function renderValues(container: HTMLElement, change: SemanticChange): void {
  if (change.kind === "moved") return;
  if (change.before === undefined && change.after === undefined) return;
  const values = container.createDiv({ cls: "git-note-history-semantic-values" });
  if (change.before !== undefined) {
    const before = values.createDiv({ cls: "git-note-history-semantic-value is-before" });
    before.createSpan({ text: "之前" });
    before.createDiv({ text: change.before });
  }
  if (change.after !== undefined) {
    const after = values.createDiv({ cls: "git-note-history-semantic-value is-after" });
    after.createSpan({ text: "之后" });
    after.createDiv({ text: change.after });
  }
}

function renderDetails(container: HTMLElement, change: SemanticChange): void {
  if (!change.details?.length) return;
  const details = container.createEl("details", { cls: "git-note-history-semantic-details" });
  details.createEl("summary", { text: `${change.details.length} 个单元格变化` });
  const rows = details.createDiv();
  for (const detail of change.details) {
    const row = rows.createDiv({ cls: "git-note-history-semantic-detail" });
    row.createSpan({ text: detail.label });
    row.createSpan({ cls: "is-before", text: detail.before ?? "无" });
    row.createSpan({ cls: "is-after", text: detail.after ?? "无" });
  }
}

function renderGroups(
  container: HTMLElement,
  changes: SemanticChange[],
  options: SemanticDiffRenderOptions = {}
): void {
  const groups = container.createDiv({ cls: "git-note-history-semantic-groups" });
  for (const group of semanticGroupOrder()) {
    const grouped = changes.filter((change) => change.group === group);
    if (grouped.length === 0) continue;
    const section = groups.createEl("section", { cls: "git-note-history-semantic-group" });
    const header = section.createDiv({ cls: "git-note-history-semantic-group-header" });
    header.createEl("h5", { text: group });
    header.createSpan({ text: String(grouped.length) });
    const rows = section.createDiv({ cls: "git-note-history-semantic-rows" });
    for (const change of grouped) {
      const row = rows.createDiv({ cls: `git-note-history-semantic-row is-${change.kind}` });
      const marker = row.createSpan({ cls: "git-note-history-semantic-symbol" });
      marker.createSpan({ text: KIND_SYMBOLS[change.kind] });
      marker.createSpan({ text: KIND_LABELS[change.kind] });
      const content = row.createDiv({ cls: "git-note-history-semantic-content" });
      content.createDiv({ cls: "git-note-history-semantic-label", text: change.label });
      renderLocation(content, change);
      renderValues(content, change);
      renderDetails(content, change);
      if (group === "属性" && options.onAddPropertyToBasket) {
        const action = row.createEl("button", {
          cls: "git-note-history-semantic-basket-action",
          text: "加入恢复篮子"
        });
        action.addEventListener("click", () =>
          void options.onAddPropertyToBasket?.(change.label, change)
        );
      }
    }
  }
}

export function renderSemanticOverview(
  container: HTMLElement,
  changes: SemanticChange[],
  compact = false,
  options: SemanticDiffRenderOptions = {}
): void {
  if (changes.length === 0) return;
  const shell = container.createEl(compact ? "details" : "section", {
    cls: `git-note-history-semantic-overview ${compact ? "is-compact" : "is-full"}`
  });
  const summary = compact
    ? shell.createEl("summary", { cls: "git-note-history-semantic-summary" })
    : shell.createDiv({ cls: "git-note-history-semantic-summary" });
  const title = summary.createSpan({ cls: "git-note-history-semantic-title" });
  title.createSpan({ text: "结构变化" });
  title.createSpan({ text: `${changes.length} 项` });
  const metrics = summary.createSpan({ cls: "git-note-history-semantic-metrics" });
  for (const kind of ["changed", "moved", "added", "removed"] as const) {
    const count = changes.filter((change) => change.kind === kind).length;
    if (count > 0) metrics.createSpan({ cls: `is-${kind}`, text: `${KIND_LABELS[kind]} ${count}` });
  }
  renderGroups(shell, changes, options);
}

export function renderSemanticDiff(
  container: HTMLElement,
  changes: SemanticChange[],
  options: SemanticDiffRenderOptions = {}
): void {
  container.empty();
  container.addClass("git-note-history-semantic-view");
  if (changes.length === 0) {
    container.createDiv({
      cls: "git-note-history-semantic-empty",
      text: "没有检测到属性、标题、段落、列表、表格或特殊区块的结构变化。"
    });
    return;
  }
  renderSemanticOverview(container, changes, false, options);
}
