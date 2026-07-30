import {
  ItemView,
  Notice,
  SearchComponent,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import {
  buildProvenanceLensAnalysis,
  type ProvenanceBlockAnalysis,
  type ProvenanceLensAnalysis,
  type ProvenanceLensSnapshot,
  type ProvenanceSource,
  type ProvenanceSourceKind
} from "../provenance/provenance-lens";

export const GIT_PROVENANCE_LENS_VIEW_TYPE = "git-provenance-lens";

type LensFilter = "all" | "review" | "agent" | "citation";

const SOURCE_LABELS: Record<ProvenanceSourceKind, string> = {
  human: "人工",
  agent: "Agent",
  automation: "自动化",
  script: "脚本",
  working: "工作区",
  unknown: "未知"
};

function formatTime(value: string | undefined): string {
  if (!value) return "";
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

function sourceTitle(source: ProvenanceSource): string {
  const parts = [
    SOURCE_LABELS[source.kind],
    source.label,
    source.shortHash,
    formatTime(source.authoredAt)
  ].filter(Boolean);
  return parts.join(" · ");
}

export class GitProvenanceLensView extends ItemView {
  private file: TFile | null = null;
  private snapshot: ProvenanceLensSnapshot | null = null;
  private analysis: ProvenanceLensAnalysis | null = null;
  private loading = false;
  private error = "";
  private generation = 0;
  private query = "";
  private filter: LensFilter = "all";
  private refreshTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitNoteHistoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_PROVENANCE_LENS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "来源可信度镜头";
  }

  getIcon(): string {
    return "scan-eye";
  }

  async onOpen(): Promise<void> {
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.leaf.detach();
    }, { capture: true });
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || file.path !== this.file?.path) return;
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || oldPath !== this.file?.path) return;
      this.file = file;
      void this.refresh();
    }));
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.generation += 1;
  }

  async setFile(file: TFile): Promise<void> {
    if (file.path !== this.file?.path) {
      this.query = "";
      this.filter = "all";
    }
    this.file = file;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const file = this.file;
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    this.render();
    if (!file) {
      this.loading = false;
      this.render();
      return;
    }
    try {
      const snapshot = await this.plugin.gitClient.loadProvenanceLens(file);
      if (generation !== this.generation) return;
      const analysis = buildProvenanceLensAnalysis({
        content: snapshot.content,
        ...(snapshot.previousContent !== undefined
          ? { previousContent: snapshot.previousContent }
          : {}),
        blame: snapshot.blame,
        commits: snapshot.commits,
        reviewState: this.plugin.getFileReviewState(snapshot.context)
      });
      if (generation !== this.generation) return;
      this.snapshot = snapshot;
      this.analysis = analysis;
    } catch (error) {
      if (generation !== this.generation) return;
      this.snapshot = null;
      this.analysis = null;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 800);
  }

  private visibleBlocks(): ProvenanceBlockAnalysis[] {
    if (!this.analysis) return [];
    const query = this.query.trim().toLocaleLowerCase();
    return this.analysis.blocks.filter((block) => {
      if (this.filter === "review" && !block.needsHumanReview) return false;
      if (
        this.filter === "agent"
        && !block.sources.some((source) =>
          ["agent", "automation", "script"].includes(source.kind)
        )
      ) return false;
      if (this.filter === "citation" && !block.citationSyncRisk) return false;
      if (!query) return true;
      return [
        block.text,
        block.headingPath,
        ...block.sources.flatMap((source) => [
          source.label,
          source.authorName ?? "",
          source.shortHash ?? "",
          ...Object.values(source.trailers)
        ])
      ].join(" ").toLocaleLowerCase().includes(query);
    });
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("git-provenance-lens-view");
    const header = container.createDiv({ cls: "git-provenance-lens-header" });
    const title = header.createDiv();
    title.createDiv({ cls: "git-provenance-lens-eyebrow", text: "临时只读镜头 · Esc 退出" });
    title.createEl("h2", { text: this.file?.basename ?? "来源可信度镜头" });
    if (this.file) title.createDiv({ cls: "git-provenance-lens-path", text: this.file.path });
    const refresh = header.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": this.loading ? "正在重新分析" : "重新分析来源",
        "aria-busy": String(this.loading)
      }
    });
    refresh.disabled = this.loading;
    setIcon(refresh, this.loading ? "loader-circle" : "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());

    if (!this.file) {
      this.renderState(container, "file-text", "打开一篇 Markdown 笔记后再进入可信度镜头。");
      return;
    }
    if (this.loading) {
      this.renderState(container, "loader-circle", "正在按块读取 Git 来源与审阅状态…");
      return;
    }
    if (this.error) {
      this.renderState(container, "triangle-alert", this.error, true);
      return;
    }
    if (!this.analysis || !this.snapshot) return;
    this.renderSummary(container, this.analysis, this.snapshot);
    this.renderToolbar(container);
    const blocks = this.visibleBlocks();
    const list = container.createDiv({ cls: "git-provenance-block-list" });
    if (blocks.length === 0) {
      this.renderState(list, "search-x", "当前筛选下没有知识块。");
      return;
    }
    for (const block of blocks) this.renderBlock(list, block);
  }

  private renderSummary(
    container: HTMLElement,
    analysis: ProvenanceLensAnalysis,
    snapshot: ProvenanceLensSnapshot
  ): void {
    const summary = container.createDiv({ cls: "git-provenance-summary" });
    const intro = summary.createDiv({ cls: "git-provenance-summary-copy" });
    intro.createEl("strong", { text: `${analysis.summary.totalBlocks} 个知识块` });
    intro.createSpan({
      text: analysis.summary.needsReview > 0
        ? `${analysis.summary.needsReview} 个需要人工复查`
        : "当前没有未覆盖的 Agent / 自动化修改"
    });
    const metrics = summary.createDiv({ cls: "git-provenance-summary-metrics" });
    const values: Array<[string, number, string]> = [
      ["人工", analysis.summary.humanBlocks, "human"],
      ["Agent", analysis.summary.agentBlocks, "agent"],
      ["自动化", analysis.summary.automationBlocks, "automation"],
      ["工作区", analysis.summary.workingBlocks, "working"],
      ["未知", analysis.summary.unknownBlocks, "unknown"],
      ["引用待核", analysis.summary.citationSyncRisks, "citation"]
    ];
    for (const [label, value, kind] of values) {
      const metric = metrics.createDiv({ cls: `git-provenance-metric is-${kind}` });
      metric.createSpan({ text: String(value) });
      metric.createEl("small", { text: label });
    }
    const meta = summary.createDiv({ cls: "git-provenance-summary-meta" });
    meta.createSpan({ text: `分支 ${snapshot.branch}` });
    if (analysis.reviewedThrough) {
      meta.createSpan({ text: `人工复查点 ${analysis.reviewedThrough.slice(0, 8)}` });
    } else {
      meta.createSpan({ text: "尚未建立人工复查点" });
    }
    if (snapshot.hasMoreHistory) {
      meta.createSpan({ cls: "is-warning", text: "来源历史超过 240 版；较旧块可能显示为未知" });
    }
    const latest = snapshot.commits[0];
    const mark = summary.createEl("button", {
      text: "标记当前内容已人工复查",
      cls: "git-provenance-mark-reviewed"
    });
    mark.disabled = !latest;
    mark.addEventListener("click", async () => {
      if (!latest) return;
      await this.plugin.markReviewed(
        snapshot.context,
        latest,
        snapshot.workingFingerprint
      );
      new Notice(`已把当前内容人工复查到 ${latest.shortHash}。`);
      await this.refresh();
    });
  }

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "git-provenance-toolbar" });
    const filters: Array<[LensFilter, string, string]> = [
      ["all", "全部", "blocks"],
      ["review", "待复查", "circle-alert"],
      ["agent", "Agent / 自动化", "bot"],
      ["citation", "引用待核", "quote"]
    ];
    const group = toolbar.createDiv({ cls: "git-provenance-filters" });
    for (const [id, label, icon] of filters) {
      const button = group.createEl("button", {
        cls: this.filter === id ? "is-active" : "",
        attr: { "aria-pressed": String(this.filter === id) }
      });
      setIcon(button.createSpan(), icon);
      button.createSpan({ text: label });
      button.addEventListener("click", () => {
        this.filter = id;
        this.render();
      });
    }
    const search = new SearchComponent(toolbar);
    search.setPlaceholder("搜索块、作者或来源").setValue(this.query).onChange((value) => {
      this.query = value;
      this.render();
    });
  }

  private renderBlock(container: HTMLElement, block: ProvenanceBlockAnalysis): void {
    const card = container.createDiv({
      cls: [
        "git-provenance-block",
        block.needsHumanReview ? "needs-review" : "",
        block.citationSyncRisk ? "has-citation-risk" : ""
      ].filter(Boolean).join(" ")
    });
    const rail = card.createDiv({ cls: "git-provenance-block-rail" });
    const source = block.primarySource;
    rail.createSpan({
      cls: `git-provenance-source-dot is-${source.kind}`,
      attr: { "aria-label": SOURCE_LABELS[source.kind] }
    });
    const body = card.createDiv({ cls: "git-provenance-block-body" });
    const heading = body.createDiv({ cls: "git-provenance-block-heading" });
    const location = heading.createDiv();
    location.createSpan({ text: block.headingPath });
    location.createEl("small", { text: `L${block.startLine}–${block.endLine}` });
    const badges = heading.createDiv({ cls: "git-provenance-badges" });
    for (const item of block.sources.slice(0, 3)) {
      const badge = badges.createEl("button", {
        cls: `git-provenance-source is-${item.kind}`,
        text: `${SOURCE_LABELS[item.kind]} · ${item.label}`,
        attr: { "aria-label": sourceTitle(item) }
      });
      badge.addEventListener("click", () => void this.openSource(item));
    }
    if (block.sources.length > 3) {
      badges.createSpan({ cls: "git-provenance-more", text: `+${block.sources.length - 3}` });
    }
    body.createDiv({ cls: "git-provenance-block-preview", text: block.preview || "空块" });
    if (block.needsHumanReview || block.citationSyncRisk) {
      const alerts = body.createDiv({ cls: "git-provenance-alerts" });
      if (block.needsHumanReview) {
        const alert = alerts.createDiv({ cls: "is-review" });
        setIcon(alert.createSpan(), "circle-alert");
        alert.createSpan({ text: block.reviewReason ?? "需要人工复查" });
      }
      if (block.citationSyncRisk) {
        const alert = alerts.createDiv({ cls: "is-citation" });
        setIcon(alert.createSpan(), "quote");
        alert.createSpan({ text: block.citationReason ?? "引用可能需要同步复核" });
      }
    }
    const details = body.createEl("details", { cls: "git-provenance-details" });
    details.createEl("summary", { text: "查看来源证据" });
    const evidence = details.createDiv();
    for (const item of block.sources) {
      const row = evidence.createDiv({ cls: "git-provenance-evidence-row" });
      row.createSpan({ text: sourceTitle(item) });
      row.createEl("small", { text: `${item.lineCount} 行` });
      const trailers = [
        item.trailers.authority ? `Authority: ${item.trailers.authority}` : "",
        item.trailers["send-gate"] ? `Send-Gate: ${item.trailers["send-gate"]}` : "",
        item.trailers["workflow-status"]
          ? `Workflow-Status: ${item.trailers["workflow-status"]}`
          : ""
      ].filter(Boolean);
      if (trailers.length > 0) row.createDiv({ text: trailers.join(" · ") });
    }
  }

  private async openSource(source: ProvenanceSource): Promise<void> {
    const snapshot = this.snapshot;
    const file = this.file;
    if (!snapshot || !file || !source.commitHash) return;
    const commit = snapshot.commits.find((candidate) => candidate.hash === source.commitHash);
    if (!commit) {
      new Notice("该来源提交位于当前读取窗口外，只保留了 blame 身份。", 7000);
      return;
    }
    await this.plugin.openDetail({
      filePath: file.path,
      repositoryRoot: snapshot.context.repositoryRoot,
      base: { kind: "commit", commit },
      target: { kind: "working", label: "当前工作区" },
      readOnly: true,
      initialMode: "semantic"
    });
  }

  private renderState(
    container: HTMLElement,
    icon: string,
    text: string,
    retry = false
  ): void {
    const state = container.createDiv({ cls: "git-provenance-state" });
    setIcon(state.createSpan(), icon);
    state.createDiv({ text });
    if (retry) {
      const button = state.createEl("button", { text: "重试" });
      button.addEventListener("click", () => void this.refresh());
    }
  }
}
