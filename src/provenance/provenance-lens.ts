import type {
  FileReviewState,
  GitCommitVersion
} from "../models";
import {
  extractNoteRelations,
  type NoteRelation
} from "../analysis/link-impact";
import { contentFingerprint } from "../history/version-groups";

export type ProvenanceSourceKind =
  | "human"
  | "agent"
  | "automation"
  | "script"
  | "working"
  | "unknown";

export interface BlameLine {
  line: number;
  hash: string;
  content: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  working: boolean;
}

export interface ProvenanceBlock {
  id: string;
  startLine: number;
  endLine: number;
  headingPath: string;
  kind: "frontmatter" | "heading" | "paragraph" | "list" | "code" | "quote";
  text: string;
  preview: string;
  relations: NoteRelation[];
}

export interface ProvenanceSource {
  kind: ProvenanceSourceKind;
  label: string;
  commitHash?: string;
  shortHash?: string;
  authoredAt?: string;
  authorName?: string;
  trailers: Record<string, string>;
  lineCount: number;
}

export interface ProvenanceBlockAnalysis extends ProvenanceBlock {
  sources: ProvenanceSource[];
  primarySource: ProvenanceSource;
  needsHumanReview: boolean;
  citationSyncRisk: boolean;
  reviewReason?: string;
  citationReason?: string;
}

export interface ProvenanceLensAnalysis {
  blocks: ProvenanceBlockAnalysis[];
  workingFingerprint: string;
  reviewedThrough?: string;
  summary: {
    totalBlocks: number;
    humanBlocks: number;
    agentBlocks: number;
    automationBlocks: number;
    workingBlocks: number;
    unknownBlocks: number;
    needsReview: number;
    citationSyncRisks: number;
  };
}

export interface ProvenanceLensSnapshot {
  content: string;
  previousContent?: string;
  blame: BlameLine[];
  commits: GitCommitVersion[];
  context: import("../models").GitRepositoryContext;
  branch: string;
  headHash: string;
  workingFingerprint: string;
  hasMoreHistory: boolean;
  historyPath: string;
}

const ZERO_HASH = /^0{40,64}$/;
const AUTOMATION_SUBJECT =
  /^(?:auto(?:matic)?[ -]?(?:backup|commit)|backup|vault backup|obsidian git backup|snapshot|sync|vault update|update notes?)\b/i;
const AUTOMATION_IDENTITY = /\b(?:bot|backup|sync|automation)\b/i;
const SCRIPT_IDENTITY = /\b(?:script|cron|hook|pipeline|runner)\b/i;

function normalizeEmail(value: string): string {
  return value.replace(/^<|>$/g, "");
}

function parseAuthoredAt(seconds: string): string {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) return "";
  return new Date(numeric * 1000).toISOString();
}

export function parseLinePorcelain(raw: string): BlameLine[] {
  const result: BlameLine[] = [];
  const metadataByHash = new Map<string, {
    authorName: string;
    authorEmail: string;
    authoredAt: string;
  }>();
  const rows = raw.split(/\r?\n/);
  let index = 0;
  while (index < rows.length) {
    const header = rows[index]?.match(
      /^([0-9a-f]{40,64})\s+\d+\s+(\d+)(?:\s+\d+)?$/i
    );
    if (!header) {
      index += 1;
      continue;
    }
    const hash = header[1]!.toLowerCase();
    const line = Number(header[2]);
    index += 1;
    const inherited = metadataByHash.get(hash);
    let authorName = inherited?.authorName ?? "";
    let authorEmail = inherited?.authorEmail ?? "";
    let authoredAt = inherited?.authoredAt ?? "";
    let content = "";
    while (index < rows.length) {
      const row = rows[index]!;
      if (row.startsWith("\t")) {
        content = row.slice(1);
        index += 1;
        break;
      }
      if (row.startsWith("author ")) authorName = row.slice(7);
      else if (row.startsWith("author-mail ")) {
        authorEmail = normalizeEmail(row.slice(12));
      } else if (row.startsWith("author-time ")) {
        authoredAt = parseAuthoredAt(row.slice(12));
      }
      index += 1;
    }
    metadataByHash.set(hash, { authorName, authorEmail, authoredAt });
    result.push({
      line,
      hash,
      content,
      authorName,
      authorEmail,
      authoredAt,
      working: ZERO_HASH.test(hash)
    });
  }
  return result.sort((left, right) => left.line - right.line);
}

function blockKind(text: string, frontmatter: boolean): ProvenanceBlock["kind"] {
  if (frontmatter) return "frontmatter";
  if (/^#{1,6}\s/.test(text)) return "heading";
  if (/^```|^~~~/.test(text)) return "code";
  if (/^(?:[-*+]|\d+\.)\s/.test(text)) return "list";
  if (/^>\s?/.test(text)) return "quote";
  return "paragraph";
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

export function parseMarkdownBlocks(content: string): ProvenanceBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: ProvenanceBlock[] = [];
  const headingStack: string[] = [];
  const ordinalBySection = new Map<string, number>();
  let start = 0;
  let fence = "";
  let inFrontmatter = lines[0]?.trim() === "---";

  const push = (from: number, to: number, frontmatter = false): void => {
    if (to < from) return;
    const text = lines.slice(from, to + 1).join("\n").trimEnd();
    if (!text.trim()) return;
    const heading = text.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      headingStack.splice(level - 1);
      headingStack[level - 1] = heading[2]!.trim();
    }
    const headingPath = headingStack.filter(Boolean).join(" › ") || "文档开头";
    const ordinal = (ordinalBySection.get(headingPath) ?? 0) + 1;
    ordinalBySection.set(headingPath, ordinal);
    blocks.push({
      id: `${headingPath}\u001f${ordinal}`,
      startLine: from + 1,
      endLine: to + 1,
      headingPath,
      kind: blockKind(text, frontmatter),
      text,
      preview: preview(text),
      relations: extractNoteRelations(text)
    });
  };

  if (inFrontmatter) {
    let end = 1;
    while (end < lines.length && lines[end]?.trim() !== "---") end += 1;
    if (end < lines.length) {
      push(0, end, true);
      start = end + 1;
      inFrontmatter = false;
    } else {
      inFrontmatter = false;
    }
  }

  for (let index = start; index <= lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = line.trim().match(/^(```+|~~~+)/)?.[1] ?? "";
    if (marker) {
      if (!fence) fence = marker[0]!;
      else if (marker[0] === fence) fence = "";
    }
    const boundary = index === lines.length || (!fence && line.trim() === "");
    if (!boundary) continue;
    push(start, index - 1, inFrontmatter);
    start = index + 1;
  }
  return blocks;
}

export function classifyCommitSource(
  commit: GitCommitVersion | undefined,
  line?: BlameLine
): Omit<ProvenanceSource, "lineCount"> {
  if (line?.working) {
    return {
      kind: "working",
      label: "当前工作区",
      trailers: {}
    };
  }
  if (!commit) {
    const label = line?.authorName || "来源未知";
    return {
      kind: "unknown",
      label,
      ...(line?.hash ? { commitHash: line.hash, shortHash: line.hash.slice(0, 8) } : {}),
      ...(line?.authoredAt ? { authoredAt: line.authoredAt } : {}),
      ...(line?.authorName ? { authorName: line.authorName } : {}),
      trailers: {}
    };
  }
  const trailers = commit.trailers;
  const agent = trailers.agent?.trim();
  const authority = trailers.authority?.trim() ?? "";
  const workflow = trailers["workflow-status"]?.trim() ?? "";
  if (agent) {
    return {
      kind: "agent",
      label: agent,
      commitHash: commit.hash,
      shortHash: commit.shortHash,
      authoredAt: commit.authoredAt,
      authorName: commit.authorName,
      trailers
    };
  }
  const identity = `${commit.authorName} ${commit.authorEmail} ${authority} ${workflow}`;
  if (AUTOMATION_SUBJECT.test(commit.subject) || AUTOMATION_IDENTITY.test(identity)) {
    return {
      kind: "automation",
      label: commit.subject || commit.authorName,
      commitHash: commit.hash,
      shortHash: commit.shortHash,
      authoredAt: commit.authoredAt,
      authorName: commit.authorName,
      trailers
    };
  }
  if (SCRIPT_IDENTITY.test(identity)) {
    return {
      kind: "script",
      label: commit.authorName || "脚本",
      commitHash: commit.hash,
      shortHash: commit.shortHash,
      authoredAt: commit.authoredAt,
      authorName: commit.authorName,
      trailers
    };
  }
  return {
    kind: "human",
    label: commit.authorName,
    commitHash: commit.hash,
    shortHash: commit.shortHash,
    authoredAt: commit.authoredAt,
    authorName: commit.authorName,
    trailers
  };
}

function relationIdentity(relation: NoteRelation): string {
  return `${relation.kind}\u001f${relation.target}\u001f${relation.subpath ?? ""}`;
}

function citationSet(block: ProvenanceBlock): string[] {
  return block.relations
    .filter((relation) => relation.kind !== "tag")
    .map(relationIdentity)
    .sort();
}

function contentWithoutCitationSyntax(value: string): string {
  return value
    .replace(/!?\[\[([^\]|#^]+)(?:[#^][^\]|]+)?(?:\|([^\]]+))?\]\]/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function citationSynchronizationRisks(
  current: readonly ProvenanceBlock[],
  previous: readonly ProvenanceBlock[]
): Set<string> {
  const previousById = new Map(previous.map((block) => [block.id, block]));
  const risks = new Set<string>();
  for (const block of current) {
    const before = previousById.get(block.id);
    if (!before) continue;
    const currentCitations = citationSet(block);
    if (currentCitations.length === 0) continue;
    if (!sameStrings(currentCitations, citationSet(before))) continue;
    if (
      contentWithoutCitationSyntax(block.text)
      !== contentWithoutCitationSyntax(before.text)
    ) {
      risks.add(block.id);
    }
  }
  return risks;
}

function reviewedHashes(
  commits: readonly GitCommitVersion[],
  state: FileReviewState
): Set<string> {
  const checkpoint = state.reviewCheckpoint?.commitHash;
  if (!checkpoint) return new Set();
  const checkpointIndex = commits.findIndex((commit) => commit.hash === checkpoint);
  if (checkpointIndex < 0) return new Set([checkpoint]);
  return new Set(commits.slice(checkpointIndex).map((commit) => commit.hash));
}

function sourceKey(source: Omit<ProvenanceSource, "lineCount">): string {
  return `${source.kind}\u001f${source.commitHash ?? source.label}`;
}

function sourcePriority(source: ProvenanceSource): number {
  if (source.kind === "working") return Number.MAX_SAFE_INTEGER;
  const time = Date.parse(source.authoredAt ?? "");
  return Number.isFinite(time) ? time : 0;
}

export function buildProvenanceLensAnalysis(input: {
  content: string;
  previousContent?: string;
  blame: readonly BlameLine[];
  commits: readonly GitCommitVersion[];
  reviewState: FileReviewState;
}): ProvenanceLensAnalysis {
  const blocks = parseMarkdownBlocks(input.content);
  const risks = citationSynchronizationRisks(
    blocks,
    input.previousContent ? parseMarkdownBlocks(input.previousContent) : []
  );
  const commitsByHash = new Map(input.commits.map((commit) => [commit.hash, commit]));
  const reviewed = reviewedHashes(input.commits, input.reviewState);
  const workingReviewed =
    input.reviewState.reviewedWorkingFingerprint === contentFingerprint(input.content)
    || input.reviewState.reviewCheckpoint?.workingFingerprint === contentFingerprint(input.content);
  const analyses = blocks.map((block): ProvenanceBlockAnalysis => {
    const counts = new Map<string, ProvenanceSource>();
    for (const line of input.blame) {
      if (line.line < block.startLine || line.line > block.endLine) continue;
      const classified = classifyCommitSource(commitsByHash.get(line.hash), line);
      const key = sourceKey(classified);
      const existing = counts.get(key);
      if (existing) existing.lineCount += 1;
      else counts.set(key, { ...classified, lineCount: 1 });
    }
    const sources = [...counts.values()].sort(
      (left, right) => sourcePriority(right) - sourcePriority(left)
    );
    const primarySource = sources[0] ?? {
      kind: "unknown" as const,
      label: "来源未知",
      trailers: {},
      lineCount: block.endLine - block.startLine + 1
    };
    const pending = sources.filter((source) => {
      if (!["agent", "automation", "script", "working"].includes(source.kind)) return false;
      if (source.kind === "working") return !workingReviewed;
      return !source.commitHash || !reviewed.has(source.commitHash);
    });
    const citationSyncRisk = risks.has(block.id);
    return {
      ...block,
      sources,
      primarySource,
      needsHumanReview: pending.length > 0,
      citationSyncRisk,
      ...(pending.length > 0
        ? { reviewReason: `${pending.map((source) => source.label).join("、")} 的修改尚未被当前复查点覆盖` }
        : {}),
      ...(citationSyncRisk
        ? { citationReason: "正文已变化，但该块的引用集合与上一 Git 版本相同，请确认引用是否仍支持新表述" }
        : {})
    };
  });
  const summary = {
    totalBlocks: analyses.length,
    humanBlocks: analyses.filter((block) => block.primarySource.kind === "human").length,
    agentBlocks: analyses.filter((block) => block.primarySource.kind === "agent").length,
    automationBlocks: analyses.filter((block) =>
      ["automation", "script"].includes(block.primarySource.kind)
    ).length,
    workingBlocks: analyses.filter((block) => block.primarySource.kind === "working").length,
    unknownBlocks: analyses.filter((block) => block.primarySource.kind === "unknown").length,
    needsReview: analyses.filter((block) => block.needsHumanReview).length,
    citationSyncRisks: analyses.filter((block) => block.citationSyncRisk).length
  };
  return {
    blocks: analyses,
    workingFingerprint: contentFingerprint(input.content),
    ...(input.reviewState.reviewCheckpoint?.commitHash
      ? { reviewedThrough: input.reviewState.reviewCheckpoint.commitHash }
      : {}),
    summary
  };
}
