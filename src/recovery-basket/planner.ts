import { diffLines, structuredPatch } from "diff";
import { buildLinkImpact } from "../analysis/link-impact";
import { contentFingerprint } from "../history/version-groups";
import type {
  RecoveryBasketIssue,
  RecoveryBasketItem,
  RecoveryBasketOperation,
  RecoveryBasketPlan,
  RecoveryBasketSource,
  RecoveryBasketState,
  RecoveryPatchHunk
} from "./types";

export const MAX_RECOVERY_BASKET_ITEMS = 40;
export const MAX_RECOVERY_BASKET_BYTES = 2 * 1024 * 1024;

interface PatchRange {
  start: number;
  end: number;
  insertion: boolean;
}

interface CoreEdit {
  start: number;
  removed: string[];
  added: string[];
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function patchSignature(patches: readonly RecoveryPatchHunk[]): string {
  return JSON.stringify(patches.map((patch) => [
    patch.oldStart,
    patch.oldLines,
    patch.newStart,
    patch.newLines,
    patch.lines
  ]));
}

function itemSize(item: RecoveryBasketItem): number {
  return new TextEncoder().encode(JSON.stringify(item)).byteLength;
}

function operationFromPatches(patches: readonly RecoveryPatchHunk[]): RecoveryBasketOperation {
  let removed = 0;
  let added = 0;
  for (const patch of patches) {
    removed += patch.lines.filter((line) => line.startsWith("-")).length;
    added += patch.lines.filter((line) => line.startsWith("+")).length;
  }
  if (removed === 0 && added > 0) return "insert";
  if (removed > 0 && added === 0) return "delete";
  return "replace";
}

function coreEdits(patch: RecoveryPatchHunk): CoreEdit[] {
  const edits: CoreEdit[] = [];
  let oldCursor = Math.max(0, patch.oldStart - 1);
  let active: CoreEdit | null = null;
  const flush = (): void => {
    if (!active) return;
    edits.push(active);
    active = null;
  };
  for (const line of patch.lines) {
    const prefix = line[0];
    if (prefix === " ") {
      flush();
      oldCursor += 1;
      continue;
    }
    if (prefix === "-") {
      active ??= { start: oldCursor, removed: [], added: [] };
      active.removed.push(line.slice(1));
      oldCursor += 1;
      continue;
    }
    if (prefix === "+") {
      active ??= { start: oldCursor, removed: [], added: [] };
      active.added.push(line.slice(1));
    }
  }
  flush();
  return edits;
}

function patchRanges(patch: RecoveryPatchHunk): PatchRange[] {
  return coreEdits(patch).map((edit) => ({
    start: edit.start,
    end: edit.start + edit.removed.length,
    insertion: edit.removed.length === 0
  }));
}

function rangesOverlap(left: PatchRange, right: PatchRange): boolean {
  if (left.insertion && right.insertion) return left.start === right.start;
  if (left.insertion) return left.start >= right.start && left.start <= right.end;
  if (right.insertion) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function itemsOverlap(left: RecoveryBasketItem, right: RecoveryBasketItem): boolean {
  return left.patches.some((leftPatch) =>
    right.patches.some((rightPatch) =>
      patchRanges(leftPatch).some((leftRange) =>
        patchRanges(rightPatch).some((rightRange) =>
          rangesOverlap(leftRange, rightRange)
        )
      )
    )
  );
}

function changedLineStats(before: string, after: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const part of diffLines(before, after)) {
    const count = Math.max(0, part.count ?? part.value.split(/\r?\n/).length - 1);
    if (part.added) added += count;
    if (part.removed) deleted += count;
  }
  return { added, deleted };
}

function addedCore(item: RecoveryBasketItem): string {
  return item.patches
    .flatMap((patch) => patch.lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)))
    .join("\n")
    .trim();
}

function applyItems(
  content: string,
  items: readonly RecoveryBasketItem[]
): string | null {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  const edits = items.flatMap((item) =>
    item.patches.flatMap((patch) => coreEdits(patch))
  ).sort((left, right) => {
    if (right.start !== left.start) return right.start - left.start;
    return right.removed.length - left.removed.length;
  });
  for (const edit of edits) {
    const actual = lines.slice(edit.start, edit.start + edit.removed.length);
    if (
      actual.length !== edit.removed.length
      || actual.some((line, index) => line !== edit.removed[index])
    ) return null;
    lines.splice(edit.start, edit.removed.length, ...edit.added);
  }
  return `${lines.join(newline)}${trailingNewline ? newline : ""}`;
}

function propertyOverlap(
  left: RecoveryBasketItem,
  right: RecoveryBasketItem
): string[] {
  const rightNames = new Set(right.propertyNames ?? []);
  return (left.propertyNames ?? []).filter((name) => rightNames.has(name));
}

export function createRecoveryBasket(
  filePath: string,
  baselineContent: string,
  now = new Date().toISOString()
): RecoveryBasketState {
  return {
    schemaVersion: 1,
    id: createId("basket"),
    filePath,
    baselineContent,
    baselineFingerprint: contentFingerprint(baselineContent),
    createdAt: now,
    updatedAt: now,
    items: []
  };
}

export function createRecoveryBasketItem(options: {
  filePath: string;
  kind: RecoveryBasketItem["kind"];
  label: string;
  source: RecoveryBasketSource;
  patches: RecoveryPatchHunk[];
  previewBefore: string;
  previewAfter: string;
  propertyNames?: string[];
  id?: string;
  addedAt?: string;
}): RecoveryBasketItem {
  const patches = options.patches.map((patch) => ({
    ...patch,
    lines: [...patch.lines]
  }));
  return {
    id: options.id ?? createId("basket-item"),
    filePath: options.filePath,
    kind: options.kind,
    operation: operationFromPatches(patches),
    label: options.label,
    source: { ...options.source },
    patches,
    previewBefore: options.previewBefore,
    previewAfter: options.previewAfter,
    ...(options.propertyNames?.length
      ? { propertyNames: [...new Set(options.propertyNames)] }
      : {}),
    addedAt: options.addedAt ?? new Date().toISOString()
  };
}

export function createRecoveryPatches(
  currentContent: string,
  targetContent: string
): RecoveryPatchHunk[] {
  const patch = structuredPatch(
    "current",
    "recovered",
    currentContent,
    targetContent,
    "",
    "",
    { context: 3 }
  );
  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: [...hunk.lines]
  }));
}

export function appendRecoveryBasketItem(
  basket: RecoveryBasketState,
  item: RecoveryBasketItem,
  currentContent: string,
  now = new Date().toISOString()
): RecoveryBasketState {
  if (basket.filePath !== item.filePath) {
    throw new Error("恢复篮子首版只允许收集同一篇笔记的内容。");
  }
  if (contentFingerprint(currentContent) !== basket.baselineFingerprint) {
    throw new Error("笔记已经偏离恢复篮子的冻结基线；请先打开篮子处理过期方案。");
  }
  if (basket.items.length >= MAX_RECOVERY_BASKET_ITEMS) {
    throw new Error(`一个恢复篮子最多保存 ${MAX_RECOVERY_BASKET_ITEMS} 项。`);
  }
  const next = {
    ...basket,
    items: [...basket.items, item],
    updatedAt: now
  };
  const bytes = new TextEncoder().encode(JSON.stringify(next)).byteLength;
  if (bytes > MAX_RECOVERY_BASKET_BYTES) {
    throw new Error("恢复篮子超过 2 MB 本地保存上限；请移除部分项目后再添加。");
  }
  return next;
}

export function buildRecoveryBasketPlan(
  basket: RecoveryBasketState,
  currentContent = basket.baselineContent
): RecoveryBasketPlan {
  const issues: RecoveryBasketIssue[] = [];
  const currentFingerprint = contentFingerprint(currentContent);
  const stale = currentFingerprint !== basket.baselineFingerprint;
  if (stale) {
    issues.push({
      kind: "stale",
      severity: "blocking",
      message: "当前笔记已偏离恢复篮子的冻结基线；为避免覆盖新内容，不能应用这份方案。"
    });
  }
  if (basket.items.length === 0) {
    issues.push({
      kind: "empty",
      severity: "blocking",
      message: "恢复篮子还是空的。"
    });
  }
  if (basket.items.length > MAX_RECOVERY_BASKET_ITEMS) {
    issues.push({
      kind: "item-limit",
      severity: "blocking",
      message: `恢复篮子超过 ${MAX_RECOVERY_BASKET_ITEMS} 项安全上限。`
    });
  }
  const basketBytes = new TextEncoder().encode(JSON.stringify(basket)).byteLength;
  if (basketBytes > MAX_RECOVERY_BASKET_BYTES) {
    issues.push({
      kind: "size-limit",
      severity: "blocking",
      message: "恢复篮子超过 2 MB 本地保存上限。"
    });
  }

  const signatures = new Map<string, string>();
  const effectiveItems: RecoveryBasketItem[] = [];
  const skippedDuplicateItemIds: string[] = [];
  for (const item of basket.items) {
    const signature = patchSignature(item.patches);
    const existing = signatures.get(signature);
    if (existing) {
      skippedDuplicateItemIds.push(item.id);
      issues.push({
        kind: "duplicate-item",
        severity: "warning",
        itemIds: [existing, item.id],
        message: `“${item.label}”与篮子中的另一项完全相同，预演时只应用一次。`
      });
      continue;
    }
    signatures.set(signature, item.id);
    effectiveItems.push(item);
  }

  for (let leftIndex = 0; leftIndex < effectiveItems.length; leftIndex += 1) {
    const left = effectiveItems[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < effectiveItems.length; rightIndex += 1) {
      const right = effectiveItems[rightIndex]!;
      const sharedProperties = propertyOverlap(left, right);
      if (sharedProperties.length > 0) {
        issues.push({
          kind: "property-overwrite",
          severity: "blocking",
          itemIds: [left.id, right.id],
          message: `属性 ${sharedProperties.join("、")} 被多个来源同时覆盖；请只保留一个版本。`
        });
        continue;
      }
      if (itemsOverlap(left, right)) {
        issues.push({
          kind: "overlap",
          severity: "blocking",
          itemIds: [left.id, right.id],
          message: `“${left.label}”与“${right.label}”修改了重叠位置，不能自动决定应用顺序。`
        });
      }
    }
  }

  for (const item of effectiveItems) {
    const core = addedCore(item);
    if (
      core.length >= 12
      && basket.baselineContent.includes(core)
      && !item.previewBefore.includes(core)
    ) {
      issues.push({
        kind: "duplicate-content",
        severity: "warning",
        itemIds: [item.id],
        message: `“${item.label}”准备加入的内容已经在当前笔记其他位置出现。`
      });
    }
  }

  let targetContent = basket.baselineContent;
  const appliedItemIds: string[] = [];
  const canBuild = !issues.some((issue) =>
    issue.severity === "blocking"
    && issue.kind !== "stale"
    && issue.kind !== "empty"
  );
  if (canBuild && effectiveItems.length > 0) {
    const applied = applyItems(basket.baselineContent, effectiveItems);
    if (applied === null) {
      issues.push({
        kind: "invalid-patch",
        severity: "blocking",
        itemIds: effectiveItems.map((item) => item.id),
        message: "至少一个项目无法在冻结基线上精确定位，方案未应用。"
      });
    } else {
      targetContent = applied;
      appliedItemIds.push(...effectiveItems.map((item) => item.id));
    }
  }

  const impact = buildLinkImpact(basket.baselineContent, targetContent);
  if (impact.removed.length > 0) {
    issues.push({
      kind: "link-removal",
      severity: "warning",
      message: `最终方案会移除 ${impact.removed.length} 个链接、嵌入或标签关系。`
    });
  }
  const stats = changedLineStats(basket.baselineContent, targetContent);
  const blocking = issues.some((issue) => issue.severity === "blocking");
  return {
    filePath: basket.filePath,
    baselineContent: basket.baselineContent,
    targetContent,
    baselineFingerprint: basket.baselineFingerprint,
    currentFingerprint,
    stale,
    issues,
    appliedItemIds,
    skippedDuplicateItemIds,
    addedLines: stats.added,
    deletedLines: stats.deleted,
    removedRelations: impact.removed.map((relation) => ({
      kind: relation.kind,
      label: relation.label,
      target: relation.target
    })),
    canApply: !blocking
      && basket.items.length > 0
      && targetContent !== basket.baselineContent
  };
}

export function totalRecoveryBasketItemBytes(items: readonly RecoveryBasketItem[]): number {
  return items.reduce((total, item) => total + itemSize(item), 0);
}
