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

export const GIT_HISTORY_HEALTH_VIEW_TYPE = "git-history-health";
const MAX_SIGNAL_CONTENT_BYTES = 2 * 1024 * 1024;

const SIGNAL_LABELS: Record<HistorySignalKind, string> = {
  content: "有效内容",
  metadata: "维护属性",
  generated: "生成字段",
  formatting: "格式变化",
  duplicate: "重复内容",
  "ignored-revision": "Ignore rev",
  unknown: "未知"
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
    return "历史健康中心";
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
    container.addClass("git-history-health-view");
    const header = container.createDiv({ cls: "git-history-health-header" });
    const title = header.createDiv();
    title.createDiv({
      cls: "git-history-health-eyebrow",
      text: "只读诊断 · 不 fetch、不 push、不修改 Git"
    });
    title.createEl("h2", { text: this.file?.basename ?? "历史健康中心" });
    if (this.file) title.createDiv({ cls: "git-history-health-path", text: this.file.path });
    const refresh = header.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "重新检查历史健康", "aria-busy": String(this.loading) }
    });
    refresh.disabled = this.loading;
    setIcon(refresh, this.loading ? "loader-circle" : "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());

    if (!this.file) {
      this.renderEmpty(container, "file-search", "请先打开一篇 Markdown 笔记。");
      return;
    }
    if (this.loading) {
      this.renderEmpty(container, "loader-circle", "正在读取受限历史、upstream 与对象完整性…");
      return;
    }
    if (this.error || !this.snapshot || !this.analysis) {
      this.renderEmpty(container, "circle-alert", this.error || "无法完成历史诊断。");
      return;
    }

    const summary = container.createDiv({ cls: "git-history-health-summary" });
    this.metric(summary, "有效版本", this.analysis.signalCount, "signal");
    this.metric(summary, "可解释噪音", this.analysis.noiseCount, "noise");
    this.metric(summary, "无法判断", this.analysis.unknownCount, "unknown");
    this.metric(summary, "仅本地 commit", this.snapshot.ahead, "local");

    const diagnostics = container.createDiv({ cls: "git-history-health-diagnostics" });
    diagnostics.createEl("h3", { text: "历史完整性" });
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
    signalHeader.createEl("h3", { text: "版本信噪比" });
    const profiles = signalHeader.createDiv({ cls: "git-history-health-profiles" });
    for (const [profile, label] of [
      ["balanced", "平衡"],
      ["strict", "严格"],
      ["raw", "原始 Git"]
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
      text: "过滤只影响此视图，不改写 commit、blame 或时间线。任何未知版本都会保留。规则可在插件设置中按 Vault 调整。"
    });
    const filters = signal.createDiv({ cls: "git-history-health-filters" });
    for (const [filter, label] of [
      ["signal", "当前结果"],
      ["all", "全部原始"],
      ["noise", "仅噪音"],
      ["unknown", "无法判断"]
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
      signal.createDiv({ cls: "git-history-health-empty", text: "这个筛选下没有版本。" });
      return;
    }
    const list = signal.createDiv({ cls: "git-history-health-list" });
    for (const entry of entries) {
      const index = this.analysis.entries.indexOf(entry);
      const row = list.createEl("button", {
        cls: "git-history-health-row",
        attr: { type: "button", "aria-label": `查看 ${entry.commit.shortHash} 的原始变化` }
      });
      row.dataset.kind = entry.kind;
      const badge = row.createSpan({
        cls: "git-history-health-kind",
        text: SIGNAL_LABELS[entry.kind]
      });
      badge.setAttribute("aria-hidden", "true");
      const copy = row.createDiv({ cls: "git-history-health-row-copy" });
      copy.createEl("strong", { text: entry.commit.subject || "无提交说明" });
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
