import type { GitCommitVersion } from "../models";
import type {
  GitHistoryHealthSnapshot,
  HistoryHealthAnalysis,
  HistoryHealthDiagnostic,
  HistorySignalEntry,
  HistorySignalRules
} from "./types";

const DEFAULT_IGNORED_PROPERTIES = [
  "updated",
  "modified",
  "last-modified",
  "last_modified",
  "mtime"
];
const DEFAULT_GENERATED_PROPERTIES = [
  "checksum",
  "content-hash",
  "content_hash",
  "generated",
  "generated-at",
  "generated_at"
];

interface FrontmatterSegment {
  key: string;
  lines: string[];
}

function normalizedField(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function normalizeSignalRules(
  value: Partial<HistorySignalRules> | undefined
): HistorySignalRules {
  const unique = (items: readonly string[] | undefined, fallback: string[]): string[] =>
    [...new Set((items ?? fallback).map(normalizedField).filter(Boolean))].slice(0, 64);
  return {
    profile: ["balanced", "strict", "raw"].includes(value?.profile ?? "")
      ? value!.profile!
      : "balanced",
    ignoredProperties: unique(value?.ignoredProperties, DEFAULT_IGNORED_PROPERTIES),
    generatedProperties: unique(value?.generatedProperties, DEFAULT_GENERATED_PROPERTIES),
    useBlameIgnoreRevs: value?.useBlameIgnoreRevs !== false
  };
}

function splitFrontmatter(content: string): {
  segments: FrontmatterSegment[];
  preamble: string[];
  body: string;
  valid: boolean;
} {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { segments: [], preamble: [], body: normalized, valid: false };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return { segments: [], preamble: [], body: normalized, valid: false };
  const segments: FrontmatterSegment[] = [];
  const preamble: string[] = [];
  for (let index = 1; index < end;) {
    const line = lines[index] ?? "";
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (!match) {
      if (segments.length > 0) segments.at(-1)!.lines.push(line);
      else preamble.push(line);
      index += 1;
      continue;
    }
    const segment: FrontmatterSegment = {
      key: normalizedField(match[1]!),
      lines: [line]
    };
    index += 1;
    while (
      index < end
      && !/^[A-Za-z0-9_.-]+\s*:/.test(lines[index] ?? "")
    ) {
      segment.lines.push(lines[index] ?? "");
      index += 1;
    }
    segments.push(segment);
  }
  return {
    segments,
    preamble,
    body: lines.slice(end + 1).join("\n"),
    valid: true
  };
}

function canonicalBody(value: string, strict: boolean): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  if (!strict) {
    return lines.map((line) => line.replace(/[ \t]+$/g, "")).join("\n").trimEnd();
  }
  return lines
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

function canonicalize(
  content: string,
  options: {
    removeFields?: ReadonlySet<string>;
    sortProperties?: boolean;
    strictBody?: boolean;
  } = {}
): string {
  const frontmatter = splitFrontmatter(content);
  if (!frontmatter.valid) return canonicalBody(content, Boolean(options.strictBody));
  let segments = frontmatter.segments.filter(
    (segment) =>
      !options.removeFields?.has(segment.key)
      || segment.lines.some((line) => /^\s*#/.test(line))
  );
  if (options.sortProperties) {
    segments = [...segments].sort((left, right) =>
      left.key.localeCompare(right.key)
      || left.lines.join("\n").localeCompare(right.lines.join("\n"))
    );
  }
  return [
    "---",
    ...frontmatter.preamble.map((line) => line.replace(/[ \t]+$/g, "")),
    ...segments.flatMap((segment) =>
      segment.lines.map((line) => line.replace(/[ \t]+$/g, ""))
    ),
    "---",
    canonicalBody(frontmatter.body, Boolean(options.strictBody))
  ].join("\n").trimEnd();
}

function changedFields(before: string, after: string): string[] {
  const beforeFm = splitFrontmatter(before);
  const afterFm = splitFrontmatter(after);
  if (!beforeFm.valid || !afterFm.valid) return [];
  const values = (segments: FrontmatterSegment[]): Map<string, string> =>
    new Map(segments.map((segment) => [segment.key, segment.lines.join("\n")]));
  const left = values(beforeFm.segments);
  const right = values(afterFm.segments);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => left.get(key) !== right.get(key));
}

export function classifyHistorySignal(
  commit: GitCommitVersion,
  before: string | undefined,
  after: string | undefined,
  rulesInput: Partial<HistorySignalRules> | undefined,
  ignoreRevs: ReadonlySet<string> = new Set()
): HistorySignalEntry {
  const rules = normalizeSignalRules(rulesInput);
  if (rules.useBlameIgnoreRevs && ignoreRevs.has(commit.hash)) {
    return {
      commit,
      kind: "ignored-revision",
      reason: "列在 .git-blame-ignore-revs 中",
      hiddenByProfile: rules.profile !== "raw",
      matchedFields: []
    };
  }
  if (before === undefined || after === undefined) {
    return {
      commit,
      kind: "unknown",
      reason: "版本内容不可读，未参与自动过滤",
      hiddenByProfile: false,
      matchedFields: []
    };
  }
  if (before === after) {
    return {
      commit,
      kind: "duplicate",
      reason: "内容与上一版本完全相同",
      hiddenByProfile: rules.profile !== "raw",
      matchedFields: []
    };
  }
  const fields = changedFields(before, after);
  const ignored = new Set(rules.ignoredProperties);
  const generated = new Set(rules.generatedProperties);
  const allNoiseFields = new Set([...ignored, ...generated]);
  const matchedIgnored = fields.filter((field) => ignored.has(field));
  const matchedGenerated = fields.filter((field) => generated.has(field));
  if (
    fields.length > 0
    && fields.every((field) => generated.has(field))
    && canonicalize(before, { removeFields: generated, sortProperties: true })
      === canonicalize(after, { removeFields: generated, sortProperties: true })
  ) {
    return {
      commit,
      kind: "generated",
      reason: `仅生成字段变化：${matchedGenerated.join("、")}`,
      hiddenByProfile: rules.profile !== "raw",
      matchedFields: matchedGenerated
    };
  }
  if (
    fields.length > 0
    && fields.every((field) => allNoiseFields.has(field))
    && canonicalize(before, { removeFields: allNoiseFields, sortProperties: true })
      === canonicalize(after, { removeFields: allNoiseFields, sortProperties: true })
  ) {
    return {
      commit,
      kind: "metadata",
      reason: `仅忽略属性变化：${[...matchedIgnored, ...matchedGenerated].join("、")}`,
      hiddenByProfile: rules.profile !== "raw",
      matchedFields: [...matchedIgnored, ...matchedGenerated]
    };
  }
  if (
    canonicalize(before, { sortProperties: true })
    === canonicalize(after, { sortProperties: true })
  ) {
    return {
      commit,
      kind: "formatting",
      reason: "仅换行、行尾空格或属性排序变化",
      hiddenByProfile: rules.profile !== "raw",
      matchedFields: fields
    };
  }
  if (
    rules.profile === "strict"
    && canonicalize(before, { removeFields: allNoiseFields, sortProperties: true, strictBody: true })
      === canonicalize(after, { removeFields: allNoiseFields, sortProperties: true, strictBody: true })
  ) {
    return {
      commit,
      kind: "formatting",
      reason: "严格模式判定为仅空白或批量格式变化",
      hiddenByProfile: true,
      matchedFields: fields.filter((field) => allNoiseFields.has(field))
    };
  }
  return {
    commit,
    kind: "content",
    reason: "包含实质内容或未忽略的属性变化",
    hiddenByProfile: false,
    matchedFields: fields
  };
}

export function buildHealthDiagnostics(
  snapshot: GitHistoryHealthSnapshot,
  localSnapshotCount: number
): HistoryHealthDiagnostic[] {
  const result: HistoryHealthDiagnostic[] = [];
  if (snapshot.repositoryError) {
    result.push({
      id: "repository-error",
      severity: "error",
      title: "仓库诊断未完整完成",
      detail: snapshot.repositoryError,
      suggestion: "在终端运行 git status 与 git fsck，确认仓库可读后重新检查。"
    });
  }
  if (snapshot.missingObjects.length > 0) {
    result.push({
      id: "missing-objects",
      severity: "error",
      title: `检测到 ${snapshot.missingObjects.length} 个缺失对象`,
      detail: "这篇笔记的可达历史不完整，插件不会跨缺失对象推断内容。",
      suggestion: "检查网络与 remote，再显式 fetch 所需对象；不要在未核对前清理本地仓库。"
    });
  }
  if (snapshot.shallow) {
    result.push({
      id: "shallow",
      severity: "warning",
      title: "这是浅克隆仓库",
      detail: "较早历史可能没有下载到本机。",
      suggestion: "如需完整历史，可自行运行 git fetch --unshallow；插件不会自动下载。"
    });
  }
  if (snapshot.partialClone) {
    result.push({
      id: "partial-clone",
      severity: "warning",
      title: "这是部分克隆仓库",
      detail: "部分 blob 可能只在远端；插件禁用隐式懒下载。",
      suggestion: "需要时显式 fetch 对象，并重新运行健康检查。"
    });
  }
  if (snapshot.history.hasMoreHistory) {
    result.push({
      id: "read-limit",
      severity: "warning",
      title: `单篇历史已达到 ${snapshot.history.commits.length} 条读取窗口`,
      detail: "当前列表不是这篇笔记的全部 Git 历史。",
      suggestion: "提高设置中的提交上限，或使用临时扩读入口核对原始历史。"
    });
  }
  if (snapshot.currentLfsPointer) {
    result.push({
      id: "lfs-pointer",
      severity: "warning",
      title: "当前文件内容是 Git LFS 指针",
      detail: "界面显示的是指针文本，不是实际对象内容。",
      suggestion: "在受控环境中显式获取 LFS 对象；插件不会自动运行 git lfs pull。"
    });
  }
  if (!snapshot.upstream) {
    result.push({
      id: "no-upstream",
      severity: "info",
      title: "当前分支没有 upstream",
      detail: "无法证明这些 commit 已存在于其他设备或远端。",
      suggestion: "如需同步，请先人工核对 remote 与目标分支；插件不会自动 push。"
    });
  } else if (snapshot.ahead > 0) {
    result.push({
      id: "ahead",
      severity: "warning",
      title: `${snapshot.ahead} 个 commit 仅在本地分支`,
      detail: `相对 ${snapshot.upstream} 尚未推送，其他设备可能看不到。`,
      suggestion: "核对提交和目标 remote 后自行 push；插件只做提醒。"
    });
  } else {
    result.push({
      id: "upstream",
      severity: "ok",
      title: "当前 HEAD 未领先 upstream",
      detail: snapshot.behind > 0
        ? `本地落后 ${snapshot.upstream} ${snapshot.behind} 个 commit。`
        : `与 ${snapshot.upstream} 的提交边界一致。`
    });
  }
  if (
    snapshot.history.status.staged
    || snapshot.history.status.unstaged
    || snapshot.history.status.untracked
  ) {
    result.push({
      id: "working-tree",
      severity: "info",
      title: "当前工作区内容只存在于本机",
      detail: "未提交内容不属于任何 Git commit，其他设备和历史版本都看不到。",
      suggestion: "确认内容稳定后再自行提交；插件不会自动 stage 或 commit。"
    });
  }
  if (localSnapshotCount > 0) {
    result.push({
      id: "local-snapshots",
      severity: "info",
      title: `${localSnapshotCount} 个版本只存在于插件本地快照`,
      detail: "这些版本不属于 Git，也不会自动出现在其他设备。",
      suggestion: "重要内容应通过审阅后的笔记或明确 Git 提交长期保存。"
    });
  }
  if (snapshot.ignoreRevsConfigured || snapshot.ignoreRevs.length > 0) {
    result.push({
      id: "ignore-revs",
      severity: "info",
      title: `读取到 ${snapshot.ignoreRevs.length} 条 ignore-revs 参考`,
      detail: "这些 revision 只作为可解释的噪音参考，原始 Git 列表仍可查看。"
    });
  }
  if (result.length === 0) {
    result.push({
      id: "healthy",
      severity: "ok",
      title: "未发现明显的历史完整性风险",
      detail: "这只证明当前受限检查通过，不替代完整仓库取证。"
    });
  }
  return result;
}

export function analyzeHistoryHealth(input: {
  snapshot: GitHistoryHealthSnapshot;
  contents: ReadonlyMap<string, string>;
  rules?: Partial<HistorySignalRules>;
  localSnapshotCount: number;
}): HistoryHealthAnalysis {
  const ignoreRevs = new Set(input.snapshot.history.commits
    .filter((commit) => input.snapshot.ignoreRevs.some((hash) =>
      commit.hash.startsWith(hash)
    ))
    .map((commit) => commit.hash));
  const entries = input.snapshot.history.commits.map((commit, index, commits) =>
    classifyHistorySignal(
      commit,
      input.contents.get(commits[index + 1]?.hash ?? "__empty__")
        ?? (
          index === commits.length - 1 && !input.snapshot.history.hasMoreHistory
            ? ""
            : undefined
        ),
      input.contents.get(commit.hash),
      input.rules,
      ignoreRevs
    )
  );
  const noiseCount = entries.filter((entry) =>
    !["content", "unknown"].includes(entry.kind)
  ).length;
  return {
    entries,
    diagnostics: buildHealthDiagnostics(input.snapshot, input.localSnapshotCount),
    signalCount: entries.filter((entry) => entry.kind === "content").length,
    noiseCount,
    unknownCount: entries.filter((entry) => entry.kind === "unknown").length
  };
}
