import {
  ItemView,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import {
  analyzeHistoryHealth,
  normalizeSignalRules
} from "../health/history-health";
import type {
  GitHistoryHealthSnapshot,
  HistoryHealthAnalysis,
  HistorySignalKind,
  HistorySignalProfile
} from "../health/types";
import { tr } from "../i18n";

export const GIT_HISTORY_HEALTH_VIEW_TYPE = "git-history-health";
const MAX_SIGNAL_CONTENT_BYTES = 2 * 1024 * 1024;

const SIGNAL_LABELS: Record<HistorySignalKind, string> = {
  content: tr("有效内容", "Real content"),
  metadata: tr("维护属性", "Housekeeping properties"),
  generated: tr("生成字段", "Generated fields"),
  formatting: tr("格式变化", "Formatting"),
  duplicate: tr("重复内容", "Duplicate"),
  "ignored-revision": "Ignore rev",
  unknown: tr("未知", "Unknown")
};

type HealthFilter = "signal" | "all" | "noise" | "unknown";

export class GitHistoryHealthView extends ItemView {
  private file: TFile | null = null;
  private snapshot: GitHistoryHealthSnapshot | null = null;
  private analysis: HistoryHealthAnalysis | null = null;
  private loading = false;
  private error = "";
  private generation = 0;
  private filter: HealthFilter = "signal";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitNoteHistoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_HISTORY_HEALTH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return tr("历史健康中心", "History health");
  }

  getIcon(): string {
    return "activity";
  }

  async onOpen(): Promise<void> {
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (event) => {
      if (event.key === "Escape") this.leaf.detach();
    }, { capture: true });
    this.render();
  }

  async onClose(): Promise<void> {
    this.generation += 1;
  }

  async setFile(file: TFile): Promise<void> {
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
      const snapshot = await this.plugin.gitClient.loadHistoryHealth(file);
      const contents = new Map<string, string>();
      for (let start = 0; start < snapshot.history.commits.length; start += 4) {
        if (generation !== this.generation) return;
        const batch = snapshot.history.commits.slice(start, start + 4);
        const loaded = await Promise.all(batch.map(async (commit) => {
          try {
            const content = await this.plugin.gitClient.getFileContent(
              snapshot.context.repositoryRoot,
              commit.hash,
              commit.historicalPath
            );
            return new TextEncoder().encode(content).byteLength <= MAX_SIGNAL_CONTENT_BYTES
              ? { hash: commit.hash, content }
              : null;
          } catch {
            return null;
          }
        }));
        for (const item of loaded) {
          if (item) contents.set(item.hash, item.content);
        }
      }
      if (generation !== this.generation) return;
      const rules = normalizeSignalRules({
        profile: this.plugin.settings.historySignalProfile,
        ignoredProperties: this.plugin.settings.historyIgnoredProperties,
        generatedProperties: this.plugin.settings.historyGeneratedProperties,
        useBlameIgnoreRevs: this.plugin.settings.useBlameIgnoreRevs
      });
      this.snapshot = snapshot;
      this.analysis = analyzeHistoryHealth({
        snapshot,
        contents,
        rules,
        localSnapshotCount: this.plugin.getLocalSnapshotCount(file.path)
      });
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

  private async setProfile(profile: HistorySignalProfile): Promise<void> {
    this.plugin.settings.historySignalProfile = profile;
    await this.plugin.savePluginData();
    this.filter = profile === "raw" ? "all" : this.filter;
    await this.refresh();
  }

  private visibleEntries(): NonNullable<HistoryHealthAnalysis["entries"]> {
    const entries = this.analysis?.entries ?? [];
    if (this.filter === "all") return entries;
    if (this.filter === "noise") {
      return entries.filter((entry) =>
        !["content", "unknown"].includes(entry.kind)
      );
    }
    if (this.filter === "unknown") {
      return entries.filter((entry) => entry.kind === "unknown");
    }
    return entries.filter((entry) => !entry.hiddenByProfile);
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "git-history-health-view");
    const header = container.createDiv({ cls: "git-history-health-header" });
    const title = header.createDiv();
    title.createDiv({
      cls: "git-history-health-eyebrow",
      text: tr("只读诊断 · 不 fetch、不 push、不修改 Git", "Read-only diagnosis · no fetch, no push, no Git changes")
    });
    title.createEl("h2", { text: this.file?.basename ?? tr("历史健康中心", "History health") });
    if (this.file) title.createDiv({ cls: "git-history-health-path", text: this.file.path });
    const refresh = header.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": tr("重新检查历史健康", "Check history health again"), "aria-busy": String(this.loading) }
    });
    refresh.disabled = this.loading;
    setIcon(refresh, this.loading ? "loader-circle" : "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());

    if (!this.file) {
      this.renderEmpty(container, "file-search", tr("请先打开一篇 Markdown 笔记。", "Open a Markdown note first."));
      return;
    }
    if (this.loading) {
      this.renderEmpty(container, "loader-circle", tr("正在读取受限历史、upstream 与对象完整性…", "Reading limited history, upstream and object integrity…"));
      return;
    }
    if (this.error || !this.snapshot || !this.analysis) {
      this.renderEmpty(container, "circle-alert", this.error || tr("无法完成历史诊断。", "Could not finish the history diagnosis."));
      return;
    }

    const summary = container.createDiv({ cls: "git-history-health-summary" });
    this.metric(summary, tr("有效版本", "Real versions"), this.analysis.signalCount, "signal");
    this.metric(summary, tr("可解释噪音", "Explained noise"), this.analysis.noiseCount, "noise");
    this.metric(summary, tr("无法判断", "Cannot tell"), this.analysis.unknownCount, "unknown");
    this.metric(summary, tr("仅本地 commit", "Local-only commits"), this.snapshot.ahead, "local");

    const diagnostics = container.createDiv({ cls: "git-history-health-diagnostics" });
    diagnostics.createEl("h3", { text: tr("历史完整性", "History integrity") });
    for (const item of this.analysis.diagnostics) {
      const card = diagnostics.createDiv({
        cls: `git-history-health-diagnostic is-${item.severity}`
      });
      const icon = card.createSpan();
      setIcon(icon, item.severity === "error"
        ? "circle-x"
        : item.severity === "warning"
          ? "triangle-alert"
          : item.severity === "ok"
            ? "circle-check"
            : "info");
      const copy = card.createDiv();
      copy.createEl("strong", { text: item.title });
      copy.createDiv({ text: item.detail });
      if (item.suggestion) {
        copy.createDiv({ cls: "git-history-health-suggestion", text: item.suggestion });
      }
    }

    const signal = container.createDiv({ cls: "git-history-health-signal" });
    const signalHeader = signal.createDiv({ cls: "git-history-health-section-header" });
    signalHeader.createEl("h3", { text: tr("版本信噪比", "Signal to noise") });
    const profiles = signalHeader.createDiv({ cls: "git-history-health-profiles" });
    for (const [profile, label] of [
      ["balanced", tr("平衡", "Balanced")],
      ["strict", tr("严格", "Strict")],
      ["raw", tr("原始 Git", "Raw Git")]
    ] as const) {
      const button = profiles.createEl("button", {
        text: label,
        attr: {
          type: "button",
          "aria-pressed": String(this.plugin.settings.historySignalProfile === profile)
        }
      });
      button.addEventListener("click", () => void this.setProfile(profile));
    }
    signal.createDiv({
      cls: "git-history-health-rule-note",
      text: tr("过滤只影响此视图，不改写 commit、blame 或时间线。任何未知版本都会保留。规则可在插件设置中按 Vault 调整。", "Filtering affects only this view; commits, blame and the timeline are not rewritten. Unknown versions are always kept. Rules can be set per vault in the plugin settings.")
    });
    const filters = signal.createDiv({ cls: "git-history-health-filters" });
    for (const [filter, label] of [
      ["signal", tr("当前结果", "Current result")],
      ["all", tr("全部原始", "All, raw")],
      ["noise", tr("仅噪音", "Noise only")],
      ["unknown", tr("无法判断", "Cannot tell")]
    ] as const) {
      const button = filters.createEl("button", {
        text: label,
        attr: { type: "button", "aria-pressed": String(this.filter === filter) }
      });
      button.addEventListener("click", () => {
        this.filter = filter;
        this.render();
      });
    }
    const entries = this.visibleEntries();
    if (entries.length === 0) {
      signal.createDiv({ cls: "git-history-health-empty", text: tr("这个筛选下没有版本。", "No versions under this filter.") });
      return;
    }
    const list = signal.createDiv({ cls: "git-history-health-list" });
    for (const entry of entries) {
      const index = this.analysis.entries.indexOf(entry);
      const row = list.createEl("button", {
        cls: "git-history-health-row",
        attr: { type: "button", "aria-label": tr(`查看 ${entry.commit.shortHash} 的原始变化`, `View the raw changes in ${entry.commit.shortHash}`) }
      });
      row.dataset.kind = entry.kind;
      const badge = row.createSpan({
        cls: "git-history-health-kind",
        text: SIGNAL_LABELS[entry.kind]
      });
      badge.setAttribute("aria-hidden", "true");
      const copy = row.createDiv({ cls: "git-history-health-row-copy" });
      copy.createEl("strong", { text: entry.commit.subject || tr("无提交说明", "No commit message") });
      copy.createDiv({
        cls: "git-history-health-row-reason",
        text: `${entry.commit.shortHash} · ${entry.reason}`
      });
      const arrow = row.createSpan();
      setIcon(arrow, "arrow-up-right");
      row.addEventListener("click", () => {
        void this.plugin.openHealthSignalComparison(
          this.file!,
          this.snapshot!,
          index
        ).catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        });
      });
    }
  }

  private metric(
    container: HTMLElement,
    label: string,
    value: number,
    tone: string
  ): void {
    const metric = container.createDiv({ cls: `git-history-health-metric is-${tone}` });
    metric.createEl("strong", { text: String(value) });
    metric.createSpan({ text: label });
  }

  private renderEmpty(container: HTMLElement, iconName: string, text: string): void {
    const empty = container.createDiv({ cls: "git-history-health-empty" });
    const icon = empty.createSpan();
    setIcon(icon, iconName);
    empty.createDiv({ text });
  }
}
