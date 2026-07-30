import { contentFingerprint } from "../history/version-groups";
import {
  extractMarkdownBlocks,
  findBestMatchingBlock,
  type MarkdownBlock
} from "../history/markdown-blocks";
import type {
  LocatedReviewAnnotation,
  ReviewAnnotation,
  ReviewAnnotationBlockAnchor,
  ReviewAnnotationStatus
} from "./types";

export const MAX_REVIEW_ANNOTATIONS = 1000;
export const MAX_REVIEW_ANNOTATIONS_PER_FILE = 200;
export const MAX_REVIEW_ANNOTATION_COMMENT = 4000;
export const GIT_NOTES_REVIEW_REF = "git-note-history-review";
const NOTES_START = "<!-- git-note-history:begin -->";
const NOTES_END = "<!-- git-note-history:end -->";

function iso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

export function annotationBlockAnchor(block: MarkdownBlock): ReviewAnnotationBlockAnchor {
  return {
    fingerprint: contentFingerprint(block.content),
    kind: block.kind,
    headingPath: [...block.headingPath],
    startLine: block.startLine,
    endLine: block.endLine,
    originalContent: block.content.slice(0, 2000)
  };
}

export function normalizeReviewAnnotation(value: unknown): ReviewAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ReviewAnnotation>;
  const createdAt = iso(item.createdAt);
  const updatedAt = iso(item.updatedAt);
  if (
    typeof item.id !== "string" || !item.id
    || typeof item.repositoryRoot !== "string" || !item.repositoryRoot
    || typeof item.filePath !== "string" || !item.filePath
    || typeof item.historicalPath !== "string"
    || typeof item.commitHash !== "string" || !item.commitHash
    || typeof item.versionLabel !== "string"
    || (item.target !== "version" && item.target !== "block")
    || typeof item.comment !== "string" || !item.comment.trim()
    || !["pending", "resolved", "wont-fix"].includes(item.status ?? "")
    || (item.source !== "local" && item.source !== "git-notes")
    || !createdAt || !updatedAt
  ) return null;
  let block: ReviewAnnotationBlockAnchor | undefined;
  if (item.target === "block") {
    const candidate = item.block;
    if (
      !candidate
      || typeof candidate.fingerprint !== "string"
      || !["heading", "paragraph", "list", "code", "frontmatter"].includes(candidate.kind)
      || !Array.isArray(candidate.headingPath)
      || candidate.headingPath.some((part) => typeof part !== "string")
      || !Number.isInteger(candidate.startLine)
      || !Number.isInteger(candidate.endLine)
      || typeof candidate.originalContent !== "string"
    ) return null;
    block = {
      fingerprint: candidate.fingerprint,
      kind: candidate.kind,
      headingPath: [...candidate.headingPath],
      startLine: Math.max(0, candidate.startLine),
      endLine: Math.max(candidate.startLine, candidate.endLine),
      originalContent: candidate.originalContent.slice(0, 2000)
    };
  }
  return {
    id: item.id,
    repositoryRoot: item.repositoryRoot,
    filePath: item.filePath,
    historicalPath: item.historicalPath,
    commitHash: item.commitHash,
    versionLabel: item.versionLabel.slice(0, 200),
    target: item.target,
    ...(block ? { block } : {}),
    comment: item.comment.trim().slice(0, MAX_REVIEW_ANNOTATION_COMMENT),
    status: item.status as ReviewAnnotationStatus,
    source: item.source,
    createdAt,
    updatedAt
  };
}

export function normalizeReviewAnnotations(value: unknown): Record<string, ReviewAnnotation> {
  if (!value || typeof value !== "object") return {};
  const records = Object.values(value as Record<string, unknown>)
    .map(normalizeReviewAnnotation)
    .filter((item): item is ReviewAnnotation => item !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_REVIEW_ANNOTATIONS);
  const counts = new Map<string, number>();
  const result: Record<string, ReviewAnnotation> = {};
  for (const item of records) {
    const key = `${item.repositoryRoot}\u001f${item.filePath}`;
    const count = counts.get(key) ?? 0;
    if (count >= MAX_REVIEW_ANNOTATIONS_PER_FILE) continue;
    counts.set(key, count + 1);
    result[item.id] = item;
  }
  return result;
}

export function locateReviewAnnotation(
  annotation: ReviewAnnotation,
  content: string
): LocatedReviewAnnotation {
  if (annotation.target === "version" || !annotation.block) {
    return { annotation, relocated: false, unresolved: false };
  }
  const blocks = extractMarkdownBlocks(content);
  const exact = blocks.find(
    (block) => contentFingerprint(block.content) === annotation.block?.fingerprint
  );
  if (exact) {
    const currentBlock = annotationBlockAnchor(exact);
    return {
      annotation,
      currentBlock,
      relocated: exact.startLine !== annotation.block.startLine,
      unresolved: false
    };
  }
  const match = findBestMatchingBlock({
    content: annotation.block.originalContent,
    headingPath: annotation.block.headingPath,
    kind: annotation.block.kind
  }, content);
  if (match && match.score >= 0.55) {
    return {
      annotation,
      currentBlock: annotationBlockAnchor(match.block),
      relocated: true,
      unresolved: false
    };
  }
  return { annotation, relocated: false, unresolved: true };
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

export function buildMarkdownReviewPackage(
  filePath: string,
  annotations: readonly ReviewAnnotation[]
): string {
  const sorted = [...annotations].sort((left, right) =>
    left.status.localeCompare(right.status)
    || left.updatedAt.localeCompare(right.updatedAt)
  );
  const lines = [
    "---",
    "type: git-note-history-review",
    `file: ${yaml(filePath)}`,
    `generated: ${yaml(new Date().toISOString())}`,
    `annotations: ${sorted.length}`,
    "---",
    "",
    `# ${filePath} · 版本审阅`,
    ""
  ];
  if (sorted.length === 0) {
    lines.push("> 暂无批注。", "");
    return lines.join("\n");
  }
  for (const item of sorted) {
    const status = item.status === "pending"
      ? "待处理"
      : item.status === "resolved" ? "已解决" : "无需处理";
    lines.push(
      `## ${status} · ${item.versionLabel || item.commitHash.slice(0, 8)}`,
      "",
      `- 版本：\`${item.commitHash}\``,
      `- 历史路径：\`${item.historicalPath || item.filePath}\``,
      `- 目标：${item.target === "block" ? "内容块" : "整个版本"}`,
      `- 更新时间：${item.updatedAt}`,
      ...(item.block ? [
        `- 原位置：第 ${item.block.startLine + 1}–${item.block.endLine + 1} 行`,
        `- 标题路径：${item.block.headingPath.join(" / ") || "（无）"}`
      ] : []),
      "",
      item.comment,
      "",
      ...(item.block ? ["```markdown", item.block.originalContent, "```", ""] : [])
    );
  }
  return lines.join("\n");
}

export function encodeGitNotesReview(
  existingNote: string,
  annotations: readonly ReviewAnnotation[]
): string {
  const payload = JSON.stringify({
    schemaVersion: 1,
    annotations
  }, null, 2);
  const managed = `${NOTES_START}\n${payload}\n${NOTES_END}`;
  const start = existingNote.indexOf(NOTES_START);
  const end = existingNote.indexOf(NOTES_END);
  if (start >= 0 && end >= start) {
    return `${existingNote.slice(0, start)}${managed}${existingNote.slice(end + NOTES_END.length)}`
      .trim();
  }
  return [existingNote.trim(), managed].filter(Boolean).join("\n\n");
}

export function decodeGitNotesReview(note: string): ReviewAnnotation[] {
  const start = note.indexOf(NOTES_START);
  const end = note.indexOf(NOTES_END);
  if (start < 0 || end <= start) return [];
  try {
    const payload = JSON.parse(note.slice(start + NOTES_START.length, end).trim()) as {
      schemaVersion?: unknown;
      annotations?: unknown;
    };
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.annotations)) return [];
    return payload.annotations
      .map(normalizeReviewAnnotation)
      .filter((item): item is ReviewAnnotation => item !== null);
  } catch {
    return [];
  }
}
