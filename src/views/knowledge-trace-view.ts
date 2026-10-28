import {
  ItemView,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import { traceKnowledgeBoundary } from "../knowledge-trace/boundary-search";
import type {
  KnowledgeAssertion,
  KnowledgeAssertionOutcome,
  KnowledgeBoundary,
  KnowledgeTraceConclusion,
  KnowledgeTraceResult,
  KnowledgeTraceVersion,
  KnowledgeVersionEvaluation
} from "../knowledge-trace/types";
import type {
  KnowledgeVersionMaterialization,
  KnowledgeWorkingSnapshot
} from "../knowledge-trace/version-materializer";
import type {
  DetailRequest,
  GitCommitVersion,
  VersionReference
} from "../models";
import {
  KnowledgeTraceSetupModal,
  type KnowledgeTraceSetupValue
} from "../ui/knowledge-trace-modal";

export const GIT_KNOWLEDGE_TRACE_VIEW_TYPE = "git-knowledge-trace-view";

export interface KnowledgeTraceViewRun {
  setup: KnowledgeTraceSetupValue;
  materialization: KnowledgeVersionMaterialization;
  result: KnowledgeTraceResult;
}

export interface KnowledgeTraceViewServices {
  trace: (
    setup: KnowledgeTraceSetupValue,
    signal: AbortSignal
  ) => Promise<KnowledgeTraceViewRun>;
  openComparison: (request: DetailRequest) => void | Promise<void>;
  isFrozenWorkspaceStale?: (
    filePath: string,
    snapshot: KnowledgeWorkingSnapshot
  ) => boolean | Promise<boolean>;
}

type BoundaryKind = "candidate" | "verified" | "manual" | "transition";

interface KnowledgeTimelineEntry {
  version: KnowledgeTraceVersion;
  evaluation: KnowledgeVersionEvaluation | undefined;
  index: number;
  outcome: KnowledgeAssertionOutcome;
}

function compactPath(path: string): { folder: string; name: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return { folder: parts.join("/"), name };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function outcomeCopy(outcome: KnowledgeAssertionOutcome): string {
  return {
    holds: "成立",
    "does-not-hold": "不成立",
    unknown: "未知"
  }[outcome];
}

function expectedCopy(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function assertionLabel(assertion: KnowledgeAssertion): string {
  switch (assertion.kind) {
    case "text":
      return {
        contains: `包含“${assertion.expected}”`,
        "not-contains": `不包含“${assertion.expected}”`,
        equals: `正文精确等于“${assertion.expected}”`
      }[assertion.operator];
    case "property": {
      const operation = {
        exists: "存在",
        missing: "缺失",
        equals: `等于 ${expectedCopy(assertion.expected)}`,
        contains: `包含 ${expectedCopy(assertion.expected)}`
      }[assertion.operator];
      return `属性 ${assertion.property} ${operation}`;
    }
    case "relation":
      return `${assertion.relation} ${assertion.operator === "exists" ? "存在" : "不存在"}：${assertion.target}`;
    case "structure":
      return `${assertion.structure} ${assertion.operator === "exists" ? "存在" : "不存在"}${assertion.value ? `：${assertion.value}` : ""}`;
    case "rule":
      return `规则 ${assertion.ruleId}`;
    case "manual":
      return `人工判断：${assertion.prompt}`;
  }
}

function conclusionCopy(
  conclusion: KnowledgeTraceConclusion,
  manual: boolean
): { title: string; icon: string; tone: string } {
  return {
    confirmed: {
      title: "已确认首次变化",
      icon: "badge-check",
      tone: "is-confirmed"
    },
    "manual-candidate": {
      title: "已形成一个人工候选边界",
      icon: "user-round-check",
      tone: "is-manual"
    },
    "repeated-change": {
      title: "状态曾反复变化",
      icon: "repeat-2",
      tone: "is-repeated"
    },
    "unknown-gap": {
      title: manual ? "仍有版本待人工判断" : "未知版本阻断了确认",
      icon: "circle-help",
      tone: "is-unknown"
    },
    stable: {
      title: manual ? "人工判断区间内保持稳定" : "检查区间内保持稳定",
      icon: "move-horizontal",
      tone: "is-stable"
    },
    "all-unknown": {
      title: manual ? "等待逐版人工判断" : "当前无法判定",
      icon: manual ? "user-round-search" : "circle-help",
      tone: manual ? "is-manual" : "is-unknown"
    },
    empty: {
      title: "没有可检查的版本",
      icon: "archive-x",
      tone: "is-empty"
    }
  }[conclusion];
}

function boundaryDirection(boundary: KnowledgeBoundary): string {
  return boundary.to === "holds"
    ? "由不成立变为成立"
    : "由成立变为不成立";
}

function versionReference(
  version: KnowledgeTraceVersion,
  fallbackPath: string
): VersionReference | null {
  if (version.kind === "working") {
    return {
      kind: "working",
      label: version.label ?? "当前工作区（冻结快照）"
    };
  }
  if (!version.commitHash) return null;
  const commit: GitCommitVersion = {
    hash: version.commitHash,
    shortHash: version.shortHash ?? version.commitHash.slice(0, 7),
    authorName: "",
    authorEmail: "",
    authoredAt: version.authoredAt ?? "",
    subject: version.subject ?? "历史版本",
    historicalPath: version.historicalPath ?? fallbackPath,
    changeType: "M",
    addedLines: 0,
    deletedLines: 0,
    trailers: {}
  };
  return { kind: "commit", commit };
}

export class GitKnowledgeTraceView extends ItemView {
  private setup: KnowledgeTraceSetupValue | null = null;
  private run: KnowledgeTraceViewRun | null = null;
  private loading = false;
  private error = "";
  private stale = false;
  private generation = 0;
  private traceAbortController: AbortController | null = null;
  private readonly manualOutcomes = new Map<string, KnowledgeAssertionOutcome>();
  private manualFocusOverrideKey = "";
  private staleCheckGeneration = 0;
  private closed = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly services: KnowledgeTraceViewServices
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_KNOWLEDGE_TRACE_VIEW_TYPE;
  }

  getDisplayText(): string {
    const path = this.setup ? compactPath(this.setup.filePath) : null;
    return path ? `知识边界 · ${path.name}` : "知识边界追踪";
  }

  getIcon(): string {
    return "git-compare-arrows";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.markStaleForPath(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.markStaleForPath(oldPath);
      this.markStaleForPath(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.markStaleForPath(file.path);
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view === this) void this.checkFrozenWorkspaceStale();
    }));
    this.registerDomEvent(window, "focus", () => {
      void this.checkFrozenWorkspaceStale();
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    this.staleCheckGeneration += 1;
    this.traceAbortController?.abort();
    this.traceAbortController = null;
  }

  async setRequest(setup: KnowledgeTraceSetupValue): Promise<void> {
    if (this.closed) return;
    this.setup = setup;
    this.run = null;
    this.error = "";
    this.stale = false;
    this.manualOutcomes.clear();
    this.manualFocusOverrideKey = "";
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.setup) return;
    const generation = ++this.generation;
    this.traceAbortController?.abort();
    const abortController = new AbortController();
    this.traceAbortController = abortController;
    this.loading = true;
    this.error = "";
    this.stale = false;
    this.manualOutcomes.clear();
    this.manualFocusOverrideKey = "";
    this.render();
    try {
      const run = await this.services.trace(this.setup, abortController.signal);
      if (generation !== this.generation) return;
      this.run = run;
      this.setup = run.setup;
      this.stale = run.materialization.workingSnapshot?.staleAtCompletion ?? false;
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        if (this.traceAbortController === abortController) {
          this.traceAbortController = null;
        }
        this.loading = false;
        this.render();
      }
    }
    if (generation === this.generation) {
      void this.checkFrozenWorkspaceStale();
    }
  }

  private markStaleForPath(path: string): void {
    if (
      this.closed
      || !this.run?.materialization.workingSnapshot
      || path !== this.run.materialization.filePath
      || this.stale
    ) return;
    this.stale = true;
    this.render();
  }

  private async checkFrozenWorkspaceStale(): Promise<void> {
    const run = this.run;
    const snapshot = run?.materialization.workingSnapshot;
    if (
      this.closed
      || !run
      || !snapshot
      || !this.services.isFrozenWorkspaceStale
    ) return;
    const generation = this.generation;
    const staleCheck = ++this.staleCheckGeneration;
    try {
      const stale = await this.services.isFrozenWorkspaceStale(
        run.materialization.filePath,
        snapshot
      );
      if (
        this.closed
        || generation !== this.generation
        || staleCheck !== this.staleCheckGeneration
        || run !== this.run
        || !stale
        || this.stale
      ) return;
      this.stale = true;
      this.render();
    } catch {
      // Staleness is advisory; keep the frozen trace visible if this check fails.
    }
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "git-knowledge-trace-view");
    this.renderHeader(container);

    if (this.loading) {
      const state = container.createDiv({
        cls: "git-knowledge-trace-state is-loading",
        attr: { role: "status", "aria-live": "polite" }
      });
      setIcon(state.createSpan(), "loader-circle");
      const copy = state.createDiv();
      copy.createEl("strong", { text: "正在只读检查历史版本" });
      copy.createDiv({
        text: "先定位候选，再逐版验证区间；不会运行 git bisect，也不会修改仓库。"
      });
      return;
    }
    if (this.error) {
      const state = container.createDiv({
        cls: "git-knowledge-trace-state is-error",
        attr: { role: "alert" }
      });
      setIcon(state.createSpan(), "triangle-alert");
      const copy = state.createDiv();
      copy.createEl("strong", { text: "知识边界追踪失败" });
      copy.createDiv({ text: this.error });
      const retry = copy.createEl("button", { text: "重试" });
      retry.addEventListener("click", () => void this.refresh());
      return;
    }
    if (!this.run) {
      const state = container.createDiv({
        cls: "git-knowledge-trace-state is-empty",
        attr: { role: "status" }
      });
      setIcon(state.createSpan(), "scan-search");
      const copy = state.createDiv();
      copy.createEl("strong", { text: "从一篇 Markdown 笔记开始" });
      copy.createDiv({ text: "选择一种可解释的判断，沿版本时间线寻找变化边界。" });
      return;
    }
    this.renderFrozenWorkspace(container, this.run);
    this.renderConclusion(container, this.run);
    this.renderManualFocus(container, this.run);
    this.renderBoundaries(container, this.run);
    this.renderTimeline(container, this.run);
    this.renderWarnings(container, this.run.materialization);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "git-knowledge-trace-header" });
    const identity = header.createDiv({ cls: "git-knowledge-trace-identity" });
    const eyebrow = identity.createDiv({ cls: "git-knowledge-trace-eyebrow" });
    setIcon(eyebrow.createSpan(), "scan-search");
    eyebrow.createSpan({ text: "知识边界追踪" });
    const readOnly = eyebrow.createSpan({ cls: "git-knowledge-trace-readonly" });
    setIcon(readOnly.createSpan(), "lock");
    readOnly.createSpan({ text: "只读" });
    if (this.setup) {
      const path = compactPath(this.setup.filePath);
      identity.createEl("h2", { text: path.name.replace(/\.md$/i, "") });
      if (path.folder) {
        identity.createDiv({
          cls: "git-knowledge-trace-file-path",
          text: path.folder,
          attr: { title: this.setup.filePath }
        });
      }
      const assertion = identity.createDiv({ cls: "git-knowledge-trace-assertion" });
      assertion.createSpan({
        cls: `git-knowledge-trace-assertion-kind is-${this.setup.assertion.kind}`,
        text: this.setup.assertion.kind === "manual" ? "人工判断" : "自动判断"
      });
      assertion.createEl("code", { text: assertionLabel(this.setup.assertion) });
    } else {
      identity.createEl("h2", { text: "知识边界追踪" });
      identity.createDiv({
        cls: "git-knowledge-trace-file-path",
        text: "查明一项知识在笔记历史中何时出现、失效或反复变化。"
      });
    }
    const actions = header.createDiv({ cls: "git-knowledge-trace-header-actions" });
    if (this.setup) {
      const configure = actions.createEl("button", { text: "修改条件" });
      setIcon(configure.createSpan(), "sliders-horizontal");
      configure.disabled = this.loading;
      configure.addEventListener("click", () => this.openSetup());
    }
    const rerun = actions.createEl("button", {
      cls: "mod-cta",
      text: "重新追踪"
    });
    setIcon(rerun.createSpan(), "refresh-cw");
    rerun.disabled = this.loading || !this.setup;
    rerun.addEventListener("click", () => void this.refresh());
  }

  private openSetup(): void {
    if (!this.setup || this.loading) return;
    const expectedGeneration = this.generation;
    const expectedSetup = this.setup;
    new KnowledgeTraceSetupModal(this.app, {
      filePath: this.setup.filePath,
      initialValue: {
        assertion: this.setup.assertion,
        maxVersions: this.setup.maxVersions
      },
      onSubmit: (value) => {
        if (
          this.closed
          || this.generation !== expectedGeneration
          || this.setup !== expectedSetup
        ) return;
        void this.setRequest(value);
      }
    }).open();
  }

  private renderFrozenWorkspace(
    container: HTMLElement,
    run: KnowledgeTraceViewRun
  ): void {
    const { materialization } = run;
    const frozen = container.createDiv({
      cls: `git-knowledge-trace-frozen ${this.stale ? "is-stale" : "is-current"}`,
      attr: { role: this.stale ? "alert" : "status" }
    });
    setIcon(
      frozen.createSpan({ cls: "git-knowledge-trace-frozen-icon" }),
      this.stale ? "triangle-alert" : "snowflake"
    );
    const copy = frozen.createDiv({ cls: "git-knowledge-trace-frozen-copy" });
    if (materialization.workingSnapshot) {
      copy.createEl("strong", {
        text: this.stale
          ? "当前笔记已变化，本次结果已过期"
          : "已冻结打开时的工作区版本"
      });
      copy.createDiv({
        text: this.stale
          ? "下面仍显示原采样结果；重新追踪后才会读取现在的内容。"
          : `采样于 ${formatTime(materialization.workingSnapshot.capturedAt)}；边界对比始终使用这份冻结内容。`
      });
    } else {
      copy.createEl("strong", { text: "本次追踪没有工作区快照" });
      copy.createDiv({ text: "时间线只包含可读取的 Git 提交版本。" });
    }
    const context = frozen.createDiv({ cls: "git-knowledge-trace-frozen-context" });
    context.createSpan({ text: materialization.branch || "未知分支" });
    if (materialization.headHash) {
      context.createEl("code", { text: materialization.headHash.slice(0, 7) });
    }
    context.createSpan({ text: formatTime(materialization.capturedAt) });
  }

  private renderConclusion(
    container: HTMLElement,
    run: KnowledgeTraceViewRun
  ): void {
    const manual = run.setup.assertion.kind === "manual";
    const copy = conclusionCopy(run.result.conclusion, manual);
    if (run.materialization.truncated && run.result.confirmed) {
      copy.title = "已确认当前检查区间内的唯一边界";
    }
    const section = container.createDiv({
      cls: `git-knowledge-trace-conclusion ${copy.tone}`
    });
    setIcon(
      section.createSpan({ cls: "git-knowledge-trace-conclusion-icon" }),
      copy.icon
    );
    const body = section.createDiv({ cls: "git-knowledge-trace-conclusion-copy" });
    body.createEl("h3", { text: copy.title });
    body.createDiv({
      text: run.result.conclusion === "manual-candidate"
        ? "这条边界完全来自你的逐版判断，只作为人工候选，不会标成自动确认。"
        : run.materialization.truncated && run.result.confirmed
          ? "已读取版本内不存在未知或重复转变；更早历史未纳入本次结论。"
          : run.result.summary
    });
    const binaryProbeCount = run.result.probeOrder.filter(
      (probe) => probe.phase === "binary"
    ).length;
    const verificationCount = run.result.probeOrder.filter(
      (probe) => probe.phase === "verification"
    ).length;
    body.createDiv({
      cls: "git-knowledge-trace-probe-summary",
      text: `二分探测 ${binaryProbeCount} 次 · 最终逐版验证 ${verificationCount} 个版本`
    });
    if (manual) {
      const judged = this.manualOutcomes.size;
      const readable = run.materialization.samples.filter(
        (version) => version.content !== undefined
      ).length;
      const unavailable = run.materialization.samples.length - readable;
      body.createDiv({
        cls: "git-knowledge-trace-manual-progress",
        text: `已人工判断 ${judged} / ${readable} 个可读版本${unavailable > 0 ? ` · ${unavailable} 个不可读` : ""}`
      });
    }
    const metrics = section.createDiv({ cls: "git-knowledge-trace-metrics" });
    this.renderMetric(metrics, String(run.materialization.samples.length), "版本", "versions");
    this.renderMetric(metrics, String(run.result.transitions.length), "转变", "transitions");
    this.renderMetric(metrics, String(run.result.unknownIndices.length), "未知", "unknown");
    if (run.materialization.truncated) {
      const limited = body.createDiv({ cls: "git-knowledge-trace-limited" });
      setIcon(limited.createSpan(), "gauge");
      limited.createSpan({ text: "已达到版本上限，结论只覆盖当前显示区间。" });
    }
  }

  private renderMetric(
    container: HTMLElement,
    value: string,
    label: string,
    kind: string
  ): void {
    const metric = container.createDiv({
      cls: `git-knowledge-trace-metric is-${kind}`
    });
    metric.createSpan({ cls: "git-knowledge-trace-metric-value", text: value });
    metric.createSpan({ cls: "git-knowledge-trace-metric-label", text: label });
  }

  private nextManualVersion(
    run: KnowledgeTraceViewRun
  ): KnowledgeTraceVersion | undefined {
    if (run.setup.assertion.kind !== "manual") return undefined;
    const candidates = new Map(
      run.materialization.samples.map((version) => [version.key, version])
    );
    const override = candidates.get(this.manualFocusOverrideKey);
    if (override?.content !== undefined) return override;

    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    for (const probe of run.result.probeOrder) {
      if (seen.has(probe.versionKey)) continue;
      seen.add(probe.versionKey);
      orderedKeys.push(probe.versionKey);
    }
    for (const version of run.materialization.samples) {
      if (seen.has(version.key)) continue;
      seen.add(version.key);
      orderedKeys.push(version.key);
    }
    return orderedKeys
      .map((key) => candidates.get(key))
      .find((version) =>
        version?.content !== undefined
        && !this.manualOutcomes.has(version.key)
      );
  }

  private renderManualFocus(
    container: HTMLElement,
    run: KnowledgeTraceViewRun
  ): void {
    if (run.setup.assertion.kind !== "manual") return;
    const section = container.createDiv({
      cls: "git-knowledge-trace-manual-focus"
    });
    const heading = section.createDiv({
      cls: "git-knowledge-trace-section-heading"
    });
    heading.createEl("h3", { text: "当前人工判断" });
    heading.createSpan({ text: "一次判断一个冻结版本" });

    const version = this.nextManualVersion(run);
    if (!version) {
      const completed = section.createDiv({
        cls: "git-knowledge-trace-manual-focus-card is-complete",
        attr: { tabindex: "-1" }
      });
      setIcon(completed.createSpan(), "circle-check");
      const copy = completed.createDiv();
      copy.createEl("strong", { text: "所有可读版本都已判断" });
      copy.createDiv({
        text: "结果仍然只代表人工判断；不可读版本继续保持未知。"
      });
      return;
    }

    const index = run.materialization.samples.indexOf(version);
    const card = section.createDiv({
      cls: "git-knowledge-trace-manual-focus-card",
      attr: { tabindex: "-1" }
    });
    const identity = card.createDiv({
      cls: "git-knowledge-trace-manual-focus-identity"
    });
    identity.createSpan({
      cls: "git-knowledge-trace-manual-focus-step",
      text: `${index + 1} / ${run.materialization.samples.length}`
    });
    identity.createEl("strong", {
      text: version.label ?? version.shortHash ?? `版本 ${index + 1}`
    });
    if (version.authoredAt) {
      identity.createSpan({ text: formatTime(version.authoredAt) });
    }
    this.renderManualControls(card, version);
  }

  private renderBoundaries(
    container: HTMLElement,
    run: KnowledgeTraceViewRun
  ): void {
    const manual = run.setup.assertion.kind === "manual";
    const manualBoundary = manual
      && run.result.conclusion === "manual-candidate"
      ? run.result.transitions[0] ?? null
      : null;
    const candidate = manual
      ? manualBoundary
      : run.result.transitions.length > 1
        ? null
        : run.result.candidate;
    const verified = !manual && run.result.confirmed ? run.result.boundary : null;
    if (
      !manual
      && !candidate
      && !verified
      && run.result.transitions.length === 0
    ) return;

    const section = container.createDiv({ cls: "git-knowledge-trace-boundaries" });
    section.createEl("h3", { text: "边界判断" });
    const grid = section.createDiv({ cls: "git-knowledge-trace-boundary-grid" });
    if (candidate) {
      this.renderBoundaryCard(
        grid,
        run,
        candidate,
        manual ? "manual" : "candidate"
      );
    }
    if (verified) {
      this.renderBoundaryCard(grid, run, verified, "verified");
    } else if (!manual) {
      const card = grid.createDiv({
        cls: "git-knowledge-trace-boundary is-unverified"
      });
      const title = card.createDiv({ cls: "git-knowledge-trace-boundary-title" });
      setIcon(title.createSpan(), "search-check");
      title.createEl("strong", { text: "逐版验证结果" });
      card.createDiv({
        cls: "git-knowledge-trace-boundary-copy",
        text: run.result.conclusion === "repeated-change"
          ? `发现 ${run.result.transitions.length} 次状态转变，因此没有唯一的首次边界。`
          : run.result.unknownIndices.length > 0
            ? "存在无法读取或无法判定的版本，不能把候选称为已确认边界。"
            : "当前区间没有唯一可确认的状态转变。"
      });
    } else if (!candidate && run.result.transitions.length > 1) {
      const card = grid.createDiv({
        cls: "git-knowledge-trace-boundary is-manual is-repeated"
      });
      card.createEl("strong", { text: "人工判断出现多次转变" });
      card.createDiv({
        text: "这些判断不会被压缩成一个首次边界；请在时间线逐项复核。"
      });
    } else if (!candidate) {
      const card = grid.createDiv({
        cls: "git-knowledge-trace-boundary is-manual is-pending"
      });
      card.createEl("strong", { text: "人工候选尚未形成" });
      card.createDiv({
        text: run.result.unknownIndices.length > 0
          ? "继续在时间线判断剩余版本；未知状态不会被自动跨越。"
          : "当前人工判断没有相邻状态转变。"
      });
    }
    if (run.result.transitions.length > 1) {
      run.result.transitions.forEach((transition, index) => {
        this.renderBoundaryCard(
          grid,
          run,
          transition,
          "transition",
          index + 1
        );
      });
    }
  }

  private renderBoundaryCard(
    container: HTMLElement,
    run: KnowledgeTraceViewRun,
    boundary: KnowledgeBoundary,
    kind: BoundaryKind,
    transitionNumber?: number
  ): void {
    const before = run.materialization.samples[boundary.beforeIndex];
    const after = run.materialization.samples[boundary.afterIndex];
    const card = container.createDiv({
      cls: `git-knowledge-trace-boundary is-${kind}`
    });
    const title = card.createDiv({ cls: "git-knowledge-trace-boundary-title" });
    setIcon(
      title.createSpan(),
      kind === "verified"
        ? "badge-check"
        : kind === "manual"
          ? "user-round-check"
          : kind === "transition"
            ? "repeat-2"
            : "scan-line"
    );
    title.createEl("strong", {
      text: kind === "verified"
        ? "已逐版验证"
        : kind === "manual"
          ? "人工候选"
          : kind === "transition"
            ? `${run.setup.assertion.kind === "manual" ? "人工" : ""}转变 ${transitionNumber ?? ""}`.trim()
            : "二分候选"
    });
    title.createSpan({
      cls: "git-knowledge-trace-boundary-direction",
      text: boundaryDirection(boundary)
    });
    if (before && after) {
      const route = card.createDiv({ cls: "git-knowledge-trace-boundary-route" });
      this.renderBoundaryVersion(route, before, boundary.from);
      setIcon(route.createSpan({ cls: "git-knowledge-trace-boundary-arrow" }), "arrow-right");
      this.renderBoundaryVersion(route, after, boundary.to);
    } else {
      card.createDiv({
        cls: "git-knowledge-trace-boundary-copy",
        text: "边界版本已不在当前结果中。"
      });
    }
    const canCompare = Boolean(
      before?.content !== undefined
      && after?.content !== undefined
      && before.historicalPath
      && after.historicalPath
    );
    const compare = card.createEl("button", {
      cls: kind === "verified" && canCompare ? "mod-cta" : "",
      text: kind === "manual"
        ? "打开人工候选只读对比"
        : kind === "transition"
          ? "打开这次转变只读对比"
        : "打开边界只读对比",
      attr: {
        title: canCompare
          ? "使用本次追踪冻结的两端内容"
          : "边界至少一端不可读，无法打开完整对比"
      }
    });
    setIcon(compare.createSpan(), "git-compare-arrows");
    compare.disabled = !canCompare || this.loading;
    compare.addEventListener("click", () => {
      void this.openBoundaryComparison(run, boundary);
    });
  }

  private renderBoundaryVersion(
    container: HTMLElement,
    version: KnowledgeTraceVersion,
    outcome: Exclude<KnowledgeAssertionOutcome, "unknown">
  ): void {
    const item = container.createDiv({
      cls: `git-knowledge-trace-boundary-version is-${outcome}`
    });
    item.createSpan({
      cls: "git-knowledge-trace-boundary-version-label",
      text: version.label ?? version.shortHash ?? "版本"
    });
    item.createSpan({
      cls: "git-knowledge-trace-outcome",
      text: outcomeCopy(outcome)
    });
  }

  private async openBoundaryComparison(
    run: KnowledgeTraceViewRun,
    boundary: KnowledgeBoundary
  ): Promise<void> {
    const generation = this.generation;
    const before = run.materialization.samples[boundary.beforeIndex];
    const after = run.materialization.samples[boundary.afterIndex];
    if (
      !before
      || !after
      || before.content === undefined
      || after.content === undefined
    ) {
      new Notice("边界至少一端不可读，无法打开完整对比。");
      return;
    }
    const fallbackPath = run.materialization.context.repositoryRelativePath;
    const base = versionReference(before, fallbackPath);
    const target = versionReference(after, fallbackPath);
    if (!base || !target) {
      new Notice("边界版本身份不完整，无法打开完整对比。");
      return;
    }
    const request: DetailRequest = {
      filePath: run.materialization.filePath,
      repositoryRoot: run.materialization.context.repositoryRoot,
      base,
      target,
      initialMode: "side-by-side",
      readOnly: true,
      baseContentOverride: before.content,
      targetContentOverride: after.content
    };
    await this.services.openComparison(request);
    if (generation !== this.generation) return;
  }

  private renderTimeline(
    container: HTMLElement,
    run: KnowledgeTraceViewRun
  ): void {
    const section = container.createDiv({ cls: "git-knowledge-trace-timeline" });
    const heading = section.createDiv({ cls: "git-knowledge-trace-section-heading" });
    heading.createEl("h3", { text: "版本状态时间线" });
    heading.createSpan({ text: "旧 → 新" });
    if (run.materialization.samples.length === 0) {
      section.createDiv({
        cls: "git-knowledge-trace-timeline-empty",
        text: "没有可显示的历史版本。"
      });
      return;
    }
    const candidateKeys = new Set([
      run.result.candidate?.beforeVersionKey,
      run.result.candidate?.afterVersionKey,
      ...run.result.transitions.flatMap((transition) => [
        transition.beforeVersionKey,
        transition.afterVersionKey
      ])
    ].filter((key): key is string => Boolean(key)));
    const verifiedKeys = new Set([
      run.result.boundary?.beforeVersionKey,
      run.result.boundary?.afterVersionKey
    ].filter((key): key is string => Boolean(key)));
    const evaluations = new Map(
      run.result.evaluations.map((evaluation) => [
        evaluation.versionKey,
        evaluation
      ])
    );
    const list = section.createEl("ol", {
      cls: "git-knowledge-trace-version-list"
    });
    const entries = run.materialization.samples.map(
      (version, index): KnowledgeTimelineEntry => {
        const evaluation = evaluations.get(version.key);
        return {
          version,
          evaluation,
          index,
          outcome: evaluation?.outcome ?? "unknown"
        };
      }
    );
    const groups: KnowledgeTimelineEntry[][] = [];
    for (const entry of entries) {
      const current = groups.at(-1);
      const highlighted = candidateKeys.has(entry.version.key)
        || verifiedKeys.has(entry.version.key);
      const currentHighlighted = current?.some((candidate) =>
        candidateKeys.has(candidate.version.key)
        || verifiedKeys.has(candidate.version.key)
      ) ?? false;
      if (
        !highlighted
        && !currentHighlighted
        && current?.[0]?.outcome === entry.outcome
      ) current.push(entry);
      else groups.push([entry]);
    }
    for (const group of groups) {
      if (group.length === 1) {
        const entry = group[0]!;
        this.renderVersionRow(
          list,
          run,
          entry.version,
          entry.evaluation,
          entry.index,
          candidateKeys,
          verifiedKeys
        );
        continue;
      }
      this.renderTimelineGroup(
        list,
        run,
        group,
        candidateKeys,
        verifiedKeys
      );
    }
  }

  private renderTimelineGroup(
    container: HTMLElement,
    run: KnowledgeTraceViewRun,
    entries: readonly KnowledgeTimelineEntry[],
    candidateKeys: ReadonlySet<string>,
    verifiedKeys: ReadonlySet<string>
  ): void {
    const first = entries[0]!;
    const last = entries.at(-1)!;
    const item = container.createEl("li", {
      cls: `git-knowledge-trace-version-group is-${first.outcome}`
    });
    const details = item.createEl("details");
    const summary = details.createEl("summary");
    const marker = summary.createSpan({
      cls: "git-knowledge-trace-version-group-marker"
    });
    setIcon(
      marker,
      first.outcome === "holds"
        ? "circle-check"
        : first.outcome === "does-not-hold"
          ? "circle-x"
          : "circle-help"
    );
    const copy = summary.createDiv({
      cls: "git-knowledge-trace-version-group-copy"
    });
    copy.createEl("strong", {
      text: `${outcomeCopy(first.outcome)} · 连续 ${entries.length} 个版本`
    });
    copy.createSpan({
      text: `${first.index + 1}–${last.index + 1} · ${first.version.shortHash ?? "最旧"} → ${last.version.kind === "working" ? "工作区" : last.version.shortHash ?? "最新"}`
    });
    const count = summary.createSpan({
      cls: "git-knowledge-trace-version-group-count",
      text: String(entries.length)
    });
    count.setAttribute("aria-label", `${entries.length} 个版本`);
    const chevron = summary.createSpan({
      cls: "git-knowledge-trace-version-group-chevron",
      attr: { "aria-hidden": "true" }
    });
    setIcon(chevron, "chevron-right");

    let rendered = false;
    const renderEntries = (): void => {
      if (rendered) return;
      rendered = true;
      const nested = details.createEl("ol", {
        cls: "git-knowledge-trace-version-group-list"
      });
      for (const entry of entries) {
        this.renderVersionRow(
          nested,
          run,
          entry.version,
          entry.evaluation,
          entry.index,
          candidateKeys,
          verifiedKeys
        );
      }
    };
    details.addEventListener("toggle", () => {
      if (details.open) renderEntries();
    });
  }

  private renderVersionRow(
    container: HTMLElement,
    run: KnowledgeTraceViewRun,
    version: KnowledgeTraceVersion,
    evaluation: KnowledgeVersionEvaluation | undefined,
    index: number,
    candidateKeys: ReadonlySet<string>,
    verifiedKeys: ReadonlySet<string>
  ): void {
    const outcome = evaluation?.outcome ?? "unknown";
    const row = container.createEl("li", {
      cls: `git-knowledge-trace-version is-${outcome} ${version.kind === "working" ? "is-working" : ""}`
    });
    row.createSpan({
      cls: "git-knowledge-trace-version-index",
      text: String(index + 1)
    });
    const marker = row.createSpan({ cls: "git-knowledge-trace-version-marker" });
    setIcon(
      marker,
      outcome === "holds"
        ? "circle-check"
        : outcome === "does-not-hold"
          ? "circle-x"
          : "circle-help"
    );
    const copy = row.createDiv({ cls: "git-knowledge-trace-version-copy" });
    const title = copy.createDiv({ cls: "git-knowledge-trace-version-title" });
    title.createEl("strong", {
      text: version.label ?? version.shortHash ?? `版本 ${index + 1}`
    });
    if (version.kind === "working") {
      const frozen = title.createSpan({
        cls: "git-knowledge-trace-version-badge is-working"
      });
      setIcon(frozen.createSpan(), "snowflake");
      frozen.createSpan({ text: "冻结工作区" });
    }
    if (candidateKeys.has(version.key) && run.setup.assertion.kind !== "manual") {
      title.createSpan({
        cls: "git-knowledge-trace-version-badge is-candidate",
        text: run.result.transitions.length > 1 ? "转变" : "候选"
      });
    }
    if (verifiedKeys.has(version.key) && run.result.confirmed) {
      title.createSpan({
        cls: "git-knowledge-trace-version-badge is-verified",
        text: "已验证"
      });
    }
    const meta = copy.createDiv({ cls: "git-knowledge-trace-version-meta" });
    meta.createSpan({
      cls: `git-knowledge-trace-outcome is-${outcome}`,
      text: this.manualOutcomes.has(version.key)
        ? `人工 · ${outcomeCopy(outcome)}`
        : outcomeCopy(outcome)
    });
    if (version.shortHash) meta.createEl("code", { text: version.shortHash });
    if (version.authoredAt) meta.createSpan({ text: formatTime(version.authoredAt) });
    const probes = run.result.probeOrder.filter((probe) => probe.versionKey === version.key);
    if (probes.some((probe) => probe.phase === "binary")) {
      meta.createSpan({ text: "二分探测" });
    }
    if (version.subject && !version.label?.includes(version.subject)) {
      copy.createDiv({
        cls: "git-knowledge-trace-version-subject",
        text: version.subject
      });
    }
    if (evaluation?.evidence?.excerpt) {
      const evidence = copy.createEl("details", {
        cls: "git-knowledge-trace-version-evidence"
      });
      evidence.createEl("summary", { text: "查看判断依据" });
      evidence.createEl("pre", { text: evaluation.evidence.excerpt });
    } else if (evaluation?.detail && outcome === "unknown") {
      copy.createDiv({
        cls: "git-knowledge-trace-version-reason",
        text: evaluation.detail
      });
    } else if (evaluation?.detail) {
      const explanation = copy.createEl("details", {
        cls: "git-knowledge-trace-version-explanation"
      });
      explanation.createEl("summary", { text: "查看判断说明" });
      explanation.createDiv({ text: evaluation.detail });
    }
    if (run.setup.assertion.kind === "manual") {
      if (version.content !== undefined) {
        const alreadyJudged = this.manualOutcomes.has(version.key);
        const jump = copy.createEl("button", {
          cls: "git-knowledge-trace-manual-jump",
          text: alreadyJudged ? "修改判断" : "判断此版"
        });
        setIcon(jump.createSpan(), "user-round-check");
        jump.addEventListener("click", () => {
          this.manualFocusOverrideKey = version.key;
          this.render();
          this.focusManualCard();
        });
      }
    }
  }

  private renderManualControls(
    container: HTMLElement,
    version: KnowledgeTraceVersion
  ): void {
    const controls = container.createDiv({
      cls: "git-knowledge-trace-manual-controls",
      attr: { role: "group", "aria-label": `人工判断 ${version.label ?? version.key}` }
    });
    controls.dataset.versionKey = version.key;
    const selected = this.manualOutcomes.get(version.key);
    const readable = version.content !== undefined;
    for (const option of [
      { outcome: "holds" as const, label: "成立", icon: "check" },
      { outcome: "does-not-hold" as const, label: "不成立", icon: "x" },
      { outcome: "unknown" as const, label: "未知", icon: "circle-help" }
    ]) {
      const button = controls.createEl("button", {
        cls: `git-knowledge-trace-manual-choice is-${option.outcome}`,
        text: option.label,
        attr: {
          type: "button",
          "aria-pressed": String(selected === option.outcome),
          title: readable ? "" : version.unavailableReason ?? "这个版本正文不可读"
        }
      });
      setIcon(button.createSpan(), option.icon);
      button.toggleClass("is-selected", selected === option.outcome);
      button.disabled = !readable;
      button.addEventListener("click", () => {
        this.setManualOutcome(version.key, option.outcome);
      });
    }
    if (readable) {
      const details = container.createEl("details", {
        cls: "git-knowledge-trace-manual-preview"
      });
      details.createEl("summary", { text: "查看这版冻结正文" });
      details.addEventListener("toggle", () => {
        if (!details.open || details.querySelector("pre")) return;
        const content = version.content!;
        details.createEl("pre", {
          text: content.length > 12_000
            ? `${content.slice(0, 12_000)}\n\n…正文预览已截断`
            : content
        });
      });
    }
  }

  private setManualOutcome(
    versionKey: string,
    outcome: KnowledgeAssertionOutcome
  ): void {
    const run = this.run;
    if (!run || run.setup.assertion.kind !== "manual") return;
    this.manualOutcomes.set(versionKey, outcome);
    this.manualFocusOverrideKey = "";
    const versions = run.materialization.samples.map((version) => {
      const manualOutcome = this.manualOutcomes.get(version.key);
      return manualOutcome
        ? {
            ...version,
            manualOutcome,
            manualDetail: manualOutcome === "holds"
              ? "人工判定：成立。"
              : manualOutcome === "does-not-hold"
                ? "人工判定：不成立。"
                : "人工判定：未知。"
          }
        : { ...version };
    });
    const result = traceKnowledgeBoundary({
      assertion: run.setup.assertion,
      versions
    });
    this.run = { ...run, result };
    this.render();
    this.focusManualCard();
  }

  private focusManualCard(): void {
    window.requestAnimationFrame(() => {
      const card = this.contentEl.querySelector<HTMLElement>(
        ".git-knowledge-trace-manual-focus-card"
      );
      if (!card) return;
      card.scrollIntoView({ block: "center" });
      const choice = card.querySelector<HTMLButtonElement>(
        ".git-knowledge-trace-manual-choice:not(:disabled)"
      );
      (choice ?? card).focus({ preventScroll: true });
    });
  }

  private renderWarnings(
    container: HTMLElement,
    materialization: KnowledgeVersionMaterialization
  ): void {
    if (materialization.warnings.length === 0) return;
    const details = container.createEl("details", {
      cls: "git-knowledge-trace-warnings"
    });
    const summary = details.createEl("summary");
    setIcon(summary.createSpan(), "info");
    summary.createSpan({ text: `${materialization.warnings.length} 项读取说明` });
    const list = details.createEl("ul");
    for (const warning of materialization.warnings) {
      list.createEl("li", { text: warning });
    }
  }
}
