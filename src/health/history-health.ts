import type { GitCommitVersion } from "../models";
import type {
  GitHistoryHealthSnapshot,
  HistoryHealthAnalysis,
  HistoryHealthDiagnostic,
  HistorySignalEntry,
  HistorySignalRules
} from "./types";
import { tr } from "../i18n";

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
      reason: tr("列在 .git-blame-ignore-revs 中", "Listed in .git-blame-ignore-revs"),
      hiddenByProfile: rules.profile !== "raw",
      matchedFields: []
    };
  }
  if (before === undefined || after === undefined) {
    return {
      commit,
      kind: "unknown",
      reason: tr("版本内容不可读，未参与自动过滤", "Version content cannot be read, so it is not filtered automatically"),
      hiddenByProfile: false,
      matchedFields: []
    };
  }
  if (before === after) {
    return {
      commit,
      kind: "duplicate",
      reason: tr("内容与上一版本完全相同", "Identical to the previous version"),
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
      reason: tr(`仅生成字段变化：${matchedGenerated.join("、")}`, `Only generated fields changed: ${matchedGenerated.join(", ")}`),
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
      reason: tr(`仅忽略属性变化：${[...matchedIgnored, ...matchedGenerated].join("、")}`, `Only ignored properties changed: ${[...matchedIgnored, ...matchedGenerated].join(", ")}`),
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
      reason: tr("仅换行、行尾空格或属性排序变化", "Only line breaks, trailing spaces or property order changed"),
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
      reason: tr("严格模式判定为仅空白或批量格式变化", "Strict mode: only blank space or bulk formatting changed"),
      hiddenByProfile: true,
      matchedFields: fields.filter((field) => allNoiseFields.has(field))
    };
  }
  return {
    commit,
    kind: "content",
    reason: tr("包含实质内容或未忽略的属性变化", "Real content or properties that are not ignored changed"),
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
      title: tr("仓库诊断未完整完成", "The repository check did not finish"),
      detail: snapshot.repositoryError,
      suggestion: tr("在终端运行 git status 与 git fsck，确认仓库可读后重新检查。", "Run git status and git fsck in a terminal, make sure the repository is readable, then check again.")
    });
  }
  if (snapshot.missingObjects.length > 0) {
    result.push({
      id: "missing-objects",
      severity: "error",
      title: tr(`检测到 ${snapshot.missingObjects.length} 个缺失对象`, `${snapshot.missingObjects.length} missing objects found`),
      detail: tr("这篇笔记的可达历史不完整，插件不会跨缺失对象推断内容。", "This note's reachable history is incomplete; the plugin does not infer content across missing objects."),
      suggestion: tr("检查网络与 remote，再显式 fetch 所需对象；不要在未核对前清理本地仓库。", "Check the network and remote, then fetch the needed objects yourself; do not clean the local repository before checking.")
    });
  }
  if (snapshot.shallow) {
    result.push({
      id: "shallow",
      severity: "warning",
      title: tr("这是浅克隆仓库", "This is a shallow clone"),
      detail: tr("较早历史可能没有下载到本机。", "Earlier history may not be on this computer."),
      suggestion: tr("如需完整历史，可自行运行 git fetch --unshallow；插件不会自动下载。", "For the full history, run git fetch --unshallow yourself; the plugin never downloads on its own.")
    });
  }
  if (snapshot.partialClone) {
    result.push({
      id: "partial-clone",
      severity: "warning",
      title: tr("这是部分克隆仓库", "This is a partial clone"),
      detail: tr("部分 blob 可能只在远端；插件禁用隐式懒下载。", "Some blobs may exist only on the remote; the plugin turns off lazy fetching."),
      suggestion: tr("需要时显式 fetch 对象，并重新运行健康检查。", "Fetch the objects yourself when needed, then run the health check again.")
    });
  }
  if (snapshot.history.hasMoreHistory) {
    result.push({
      id: "read-limit",
      severity: "warning",
      title: tr(`单篇历史已达到 ${snapshot.history.commits.length} 条读取窗口`, `This note's history hit the read window of ${snapshot.history.commits.length} commits`),
      detail: tr("当前列表不是这篇笔记的全部 Git 历史。", "The list is not this note's whole Git history."),
      suggestion: tr("提高设置中的提交上限，或使用临时扩读入口核对原始历史。", "Raise the commit limit in settings, or use the one-off read-more option to check the raw history.")
    });
  }
  if (snapshot.currentLfsPointer) {
    result.push({
      id: "lfs-pointer",
      severity: "warning",
      title: tr("当前文件内容是 Git LFS 指针", "The file content is a Git LFS pointer"),
      detail: tr("界面显示的是指针文本，不是实际对象内容。", "What you see is the pointer text, not the real object."),
      suggestion: tr("在受控环境中显式获取 LFS 对象；插件不会自动运行 git lfs pull。", "Fetch the LFS object yourself in a controlled environment; the plugin never runs git lfs pull.")
    });
  }
  if (!snapshot.upstream) {
    result.push({
      id: "no-upstream",
      severity: "info",
      title: tr("当前分支没有 upstream", "The current branch has no upstream"),
      detail: tr("无法证明这些 commit 已存在于其他设备或远端。", "There is no proof these commits exist on other devices or a remote."),
      suggestion: tr("如需同步，请先人工核对 remote 与目标分支；插件不会自动 push。", "To sync, check the remote and target branch yourself first; the plugin never pushes.")
    });
  } else if (snapshot.ahead > 0) {
    result.push({
      id: "ahead",
      severity: "warning",
      title: tr(`${snapshot.ahead} 个 commit 仅在本地分支`, `${snapshot.ahead} commits only on the local branch`),
      detail: tr(`相对 ${snapshot.upstream} 尚未推送，其他设备可能看不到。`, `Not pushed to ${snapshot.upstream}; other devices may not see them.`),
      suggestion: tr("核对提交和目标 remote 后自行 push；插件只做提醒。", "Check the commits and target remote, then push yourself; the plugin only reminds you.")
    });
  } else {
    result.push({
      id: "upstream",
      severity: "ok",
      title: tr("当前 HEAD 未领先 upstream", "HEAD is not ahead of upstream"),
      detail: snapshot.behind > 0
        ? tr(`本地落后 ${snapshot.upstream} ${snapshot.behind} 个 commit。`, `Local is ${snapshot.behind} commits behind ${snapshot.upstream}.`)
        : tr(`与 ${snapshot.upstream} 的提交边界一致。`, `In step with ${snapshot.upstream}.`)
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
      title: tr("当前工作区内容只存在于本机", "Working-copy content exists only on this computer"),
      detail: tr("未提交内容不属于任何 Git commit，其他设备和历史版本都看不到。", "Uncommitted content belongs to no Git commit; other devices and past versions cannot see it."),
      suggestion: tr("确认内容稳定后再自行提交；插件不会自动 stage 或 commit。", "Commit it yourself once the content is settled; the plugin never stages or commits.")
    });
  }
  if (localSnapshotCount > 0) {
    result.push({
      id: "local-snapshots",
      severity: "info",
      title: tr(`${localSnapshotCount} 个版本只存在于插件本地快照`, `${localSnapshotCount} versions exist only as the plugin's local snapshots`),
      detail: tr("这些版本不属于 Git，也不会自动出现在其他设备。", "These versions are not in Git and do not appear on other devices."),
      suggestion: tr("重要内容应通过审阅后的笔记或明确 Git 提交长期保存。", "Keep important content long term through a reviewed note or a deliberate Git commit.")
    });
  }
  if (snapshot.ignoreRevsConfigured || snapshot.ignoreRevs.length > 0) {
    result.push({
      id: "ignore-revs",
      severity: "info",
      title: tr(`读取到 ${snapshot.ignoreRevs.length} 条 ignore-revs 参考`, `${snapshot.ignoreRevs.length} ignore-revs entries read`),
      detail: tr("这些 revision 只作为可解释的噪音参考，原始 Git 列表仍可查看。", "These revisions are only a reference for explained noise; the raw Git list is still there.")
    });
  }
  if (result.length === 0) {
    result.push({
      id: "healthy",
      severity: "ok",
      title: tr("未发现明显的历史完整性风险", "No obvious history integrity risk found"),
      detail: tr("这只证明当前受限检查通过，不替代完整仓库取证。", "This only shows the limited check passed; it does not replace a full repository examination.")
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
