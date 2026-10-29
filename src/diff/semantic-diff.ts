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
import { tr } from "../i18n";

const KIND_LABELS: Record<SemanticChangeKind, string> = {
  added: tr("新增", "Added"),
  removed: tr("删除", "Removed"),
  changed: tr("修改", "Changed"),
  moved: tr("移动", "Moved")
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
      text: tr(`${change.beforeContext ?? "原位置"} → ${change.afterContext ?? "新位置"}`, `${change.beforeContext ?? "original place"} → ${change.afterContext ?? "new place"}`)
    });
    return;
  }
  const line = change.afterLine ?? change.beforeLine;
  const context = change.afterContext ?? change.beforeContext;
  if (context) location.createSpan({ text: context });
  if (line !== undefined) location.createSpan({ text: tr(`第 ${line} 行`, `Line ${line}`) });
}

function renderValues(container: HTMLElement, change: SemanticChange): void {
  if (change.kind === "moved") return;
  if (change.before === undefined && change.after === undefined) return;
  const values = container.createDiv({ cls: "git-note-history-semantic-values" });
  if (change.before !== undefined) {
    const before = values.createDiv({ cls: "git-note-history-semantic-value is-before" });
    before.createSpan({ text: tr("之前", "Before") });
    before.createDiv({ text: change.before });
  }
  if (change.after !== undefined) {
    const after = values.createDiv({ cls: "git-note-history-semantic-value is-after" });
    after.createSpan({ text: tr("之后", "After") });
    after.createDiv({ text: change.after });
  }
}

function renderDetails(container: HTMLElement, change: SemanticChange): void {
  if (!change.details?.length) return;
  const details = container.createEl("details", { cls: "git-note-history-semantic-details" });
  details.createEl("summary", { text: tr(`${change.details.length} 个单元格变化`, `${change.details.length} cells changed`) });
  const rows = details.createDiv();
  for (const detail of change.details) {
    const row = rows.createDiv({ cls: "git-note-history-semantic-detail" });
    row.createSpan({ text: detail.label });
    row.createSpan({ cls: "is-before", text: detail.before ?? tr("无", "None") });
    row.createSpan({ cls: "is-after", text: detail.after ?? tr("无", "None") });
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
    header.createEl("h5", { text: semanticGroupLabel(group) });
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
          text: tr("加入恢复篮子", "Add to recovery basket")
        });
        action.addEventListener("click", () =>
          void options.onAddPropertyToBasket?.(change.label, change)
        );
      }
    }
  }
}

// 分组名是逻辑里用的中文键，显示时再翻
const SEMANTIC_GROUP_EN: Record<string, string> = {
  属性: "Properties", 标题: "Headings", 段落: "Paragraphs", 列表: "Lists", 任务: "Tasks",
  表格: "Tables", Callout: "Callouts", 代码: "Code", 公式: "Math", 链接: "Links"
};

export function semanticGroupLabel(group: string): string {
  return tr(group, SEMANTIC_GROUP_EN[group] ?? group);
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
  title.createSpan({ text: tr("结构变化", "Structure changes") });
  title.createSpan({ text: tr(`${changes.length} 项`, `${changes.length}`) });
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
      text: tr("没有检测到属性、标题、段落、列表、表格或特殊区块的结构变化。", "No structure changes in properties, headings, paragraphs, lists, tables or special blocks.")
    });
    return;
  }
  renderSemanticOverview(container, changes, false, options);
}
