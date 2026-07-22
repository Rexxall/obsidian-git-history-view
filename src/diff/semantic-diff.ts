export interface SemanticChange {
  group: "Properties" | "结构" | "任务" | "链接";
  kind: "added" | "removed" | "changed";
  label: string;
  before?: string;
  after?: string;
}

function parseFrontmatter(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) return result;
  for (const line of match[1].split(/\r?\n/)) {
    const property = /^([^:#][^:]*):\s*(.*)$/.exec(line);
    if (property?.[1]) result.set(property[1].trim(), property[2]?.trim() ?? "");
  }
  return result;
}

function collect(text: string, pattern: RegExp, valueIndex = 1): Set<string> {
  const result = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const value = match[valueIndex]?.trim();
    if (value) result.add(value);
  }
  return result;
}

function compareSets(
  group: SemanticChange["group"],
  before: Set<string>,
  after: Set<string>
): SemanticChange[] {
  const changes: SemanticChange[] = [];
  for (const value of before) if (!after.has(value)) changes.push({ group, kind: "removed", label: value });
  for (const value of after) if (!before.has(value)) changes.push({ group, kind: "added", label: value });
  return changes;
}

export function buildSemanticDiff(beforeText: string, afterText: string): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const beforeProperties = parseFrontmatter(beforeText);
  const afterProperties = parseFrontmatter(afterText);
  const propertyNames = new Set([...beforeProperties.keys(), ...afterProperties.keys()]);
  for (const name of propertyNames) {
    const before = beforeProperties.get(name);
    const after = afterProperties.get(name);
    if (before === after) continue;
    const change: SemanticChange = {
      group: "Properties",
      kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
      label: name
    };
    if (before !== undefined) change.before = before;
    if (after !== undefined) change.after = after;
    changes.push(change);
  }

  changes.push(
    ...compareSets("结构", collect(beforeText, /^#{1,6}\s+(.+)$/gm), collect(afterText, /^#{1,6}\s+(.+)$/gm)),
    ...compareSets("任务", collect(beforeText, /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gm), collect(afterText, /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gm)),
    ...compareSets("链接", collect(beforeText, /\[\[([^\]]+)\]\]/g), collect(afterText, /\[\[([^\]]+)\]\]/g))
  );

  return changes;
}

export function renderSemanticDiff(container: HTMLElement, changes: SemanticChange[]): void {
  container.empty();
  if (changes.length === 0) {
    container.createDiv({ cls: "git-note-history-semantic-empty", text: "没有检测到属性、标题、任务或 Wiki 链接层面的变化。" });
    return;
  }

  for (const group of ["Properties", "结构", "任务", "链接"] as const) {
    const grouped = changes.filter((change) => change.group === group);
    if (grouped.length === 0) continue;
    const section = container.createDiv({ cls: "git-note-history-semantic-group" });
    section.createEl("h5", { text: group });
    for (const change of grouped) {
      const row = section.createDiv({ cls: `git-note-history-semantic-row is-${change.kind}` });
      row.createSpan({ cls: "git-note-history-semantic-symbol", text: change.kind === "added" ? "+" : change.kind === "removed" ? "−" : "↔" });
      row.createSpan({ cls: "git-note-history-semantic-label", text: change.label });
      if (change.kind === "changed") {
        row.createSpan({ cls: "git-note-history-semantic-value", text: `${change.before ?? ""} → ${change.after ?? ""}` });
      }
    }
  }
}
