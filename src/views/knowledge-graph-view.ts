import {
  ItemView,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import {
  filterKnowledgeGraphTransitions,
  type KnowledgeGraphTimeline,
  type KnowledgeGraphTransition
} from "../knowledge-graph/time-machine";
import type {
  NoteRelation,
  NoteRelationKind
} from "../analysis/link-impact";
import { tr } from "../i18n";

export const GIT_KNOWLEDGE_GRAPH_VIEW_TYPE = "git-knowledge-graph-time-machine";

type RelationFilter = "links" | "embed" | "attachment" | "tag" | "footnote";

const FILTERS: Array<{
  id: RelationFilter;
  label: string;
  icon: string;
  kinds: NoteRelationKind[];
}> = [
  { id: "links", label: tr("链接", "Links"), icon: "link", kinds: ["wikilink", "markdown"] },
  { id: "embed", label: tr("嵌入", "Embeds"), icon: "panel-top", kinds: ["embed"] },
  { id: "attachment", label: tr("附件", "Attachments"), icon: "paperclip", kinds: ["attachment"] },
  { id: "tag", label: tr("标签", "Tags"), icon: "tag", kinds: ["tag"] },
  { id: "footnote", label: tr("脚注", "Footnotes"), icon: "superscript", kinds: ["footnote"] }
];

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

function relationLabel(relation: NoteRelation): string {
  return `${relation.label}${relation.subpath ?? ""}`;
}

function kindLabel(kind: NoteRelationKind): string {
  return {
    wikilink: tr("双链", "Wikilink"),
    markdown: tr("链接", "Link"),
    embed: tr("嵌入", "Embed"),
    attachment: tr("附件", "Attachment"),
    tag: tr("标签", "Tag"),
    footnote: tr("脚注", "Footnote")
  }[kind];
}

export class GitKnowledgeGraphView extends ItemView {
  private file: TFile | null = null;
  private timeline: KnowledgeGraphTimeline | null = null;
  private loading = false;
  private error = "";
  private generation = 0;
  private controller: AbortController | null = null;
  private activeFilters = new Set<RelationFilter>();
  private selectedIndex = 0;
  private playbackTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitNoteHistoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_KNOWLEDGE_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return tr("知识图谱时间机", "Knowledge graph time machine");
  }

  getIcon(): string {
    return "orbit";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.path === this.file?.path) {
        void this.refresh();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || oldPath !== this.file?.path) return;
      this.file = file;
      void this.refresh();
    }));
    this.render();
  }

  async onClose(): Promise<void> {
    this.stopPlayback();
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
  }

  async setFile(file: TFile): Promise<void> {
    if (file.path !== this.file?.path) {
      this.selectedIndex = 0;
      this.activeFilters.clear();
    }
    this.file = file;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const file = this.file;
    this.stopPlayback();
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
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
      const timeline = await this.plugin.loadKnowledgeGraphTimeline(
        file,
        controller.signal
      );
      if (generation !== this.generation || controller.signal.aborted) return;
      this.timeline = timeline;
      this.selectedIndex = Math.max(
        0,
        this.filteredTransitions(timeline).length - 1
      );
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private selectedKinds(): Set<NoteRelationKind> {
    const kinds = new Set<NoteRelationKind>();
    for (const filter of FILTERS) {
      if (!this.activeFilters.has(filter.id)) continue;
      for (const kind of filter.kinds) kinds.add(kind);
    }
    return kinds;
  }

  private filteredTransitions(
    timeline = this.timeline
  ): KnowledgeGraphTransition[] {
    return timeline
      ? filterKnowledgeGraphTransitions(timeline, this.selectedKinds())
      : [];
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "git-note-history-graph-machine");
    this.renderHeader(container);
    if (!this.file) {
      this.renderEmpty(container, "file-text", tr("请先打开一篇 Markdown 笔记", "Open a Markdown note first"));
      return;
    }
    if (this.loading && !this.timeline) {
      this.renderEmpty(container, "loader-circle", tr("正在读取关系历史", "Reading link history"));
      return;
    }
    if (this.error) {
      this.renderEmpty(container, "triangle-alert", this.error);
      return;
    }
    if (!this.timeline) return;
    this.renderFilters(container);
    const transitions = this.filteredTransitions();
    if (transitions.length === 0) {
      this.renderEmpty(
        container,
        "git-compare",
        this.activeFilters.size
          ? tr("所选关系类型没有发生变化", "The chosen relation types did not change")
          : tr("已读取版本之间没有关系变化", "No relation changes between the versions read")
      );
      this.renderWarnings(container);
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, transitions.length - 1);
    this.renderPlayer(container, transitions);
    this.renderStage(container, transitions[this.selectedIndex]!);
    this.renderEventRail(container, transitions);
    this.renderWarnings(container);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({
      cls: "git-note-history-graph-machine-header"
    });
    const identity = header.createDiv();
    const eyebrow = identity.createDiv({
      cls: "git-note-history-graph-machine-eyebrow"
    });
    setIcon(eyebrow.createSpan(), "orbit");
    eyebrow.createSpan({ text: tr("知识图谱时间机", "Knowledge graph time machine") });
    identity.createEl("h2", { text: this.file?.basename ?? tr("关系演化", "Relation history") });
    if (this.file) identity.createDiv({
      cls: "git-note-history-graph-machine-path",
      text: this.file.path
    });
    const refresh = header.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": tr("重新读取关系历史", "Read link history again") }
    });
    setIcon(refresh, "refresh-cw");
    refresh.disabled = this.loading || !this.file;
    refresh.addEventListener("click", () => void this.refresh());
  }

  private renderFilters(container: HTMLElement): void {
    const bar = container.createDiv({
      cls: "git-note-history-graph-machine-filters"
    });
    bar.createSpan({ text: tr("只看", "Show only") });
    for (const filter of FILTERS) {
      const active = this.activeFilters.has(filter.id);
      const button = bar.createEl("button", {
        cls: active ? "is-active" : "",
        attr: { "aria-pressed": String(active) }
      });
      setIcon(button.createSpan(), filter.icon);
      button.createSpan({ text: filter.label });
      button.addEventListener("click", () => {
        if (active) this.activeFilters.delete(filter.id);
        else this.activeFilters.add(filter.id);
        this.selectedIndex = Math.max(0, this.filteredTransitions().length - 1);
        this.stopPlayback();
        this.render();
      });
    }
    if (this.activeFilters.size) {
      const clear = bar.createEl("button", {
        cls: "git-note-history-graph-machine-filter-clear",
        text: tr("全部", "All")
      });
      clear.addEventListener("click", () => {
        this.activeFilters.clear();
        this.selectedIndex = Math.max(0, this.filteredTransitions().length - 1);
        this.render();
      });
    }
  }

  private renderPlayer(
    container: HTMLElement,
    transitions: KnowledgeGraphTransition[]
  ): void {
    const player = container.createDiv({
      cls: "git-note-history-graph-machine-player"
    });
    const controls = player.createDiv();
    const previous = controls.createEl("button", {
      attr: { "aria-label": tr("上一处关系变化", "Previous relation change") }
    });
    setIcon(previous, "chevron-left");
    previous.disabled = this.selectedIndex === 0;
    previous.addEventListener("click", () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.stopPlayback();
      this.render();
    });
    const play = controls.createEl("button", {
      cls: "git-note-history-graph-machine-play",
      attr: { "aria-label": this.playbackTimer === null ? tr("播放关系变化", "Play relation changes") : tr("暂停播放", "Pause") }
    });
    setIcon(play, this.playbackTimer === null ? "play" : "pause");
    play.addEventListener("click", () => {
      if (this.playbackTimer === null) this.startPlayback(transitions.length);
      else this.stopPlayback();
      this.render();
    });
    const next = controls.createEl("button", {
      attr: { "aria-label": tr("下一处关系变化", "Next relation change") }
    });
    setIcon(next, "chevron-right");
    next.disabled = this.selectedIndex >= transitions.length - 1;
    next.addEventListener("click", () => {
      this.selectedIndex = Math.min(
        transitions.length - 1,
        this.selectedIndex + 1
      );
      this.stopPlayback();
      this.render();
    });
    const range = player.createEl("input", {
      type: "range",
      attr: {
        min: "0",
        max: String(transitions.length - 1),
        value: String(this.selectedIndex),
        "aria-label": tr("关系变化时间轴", "Relation change timeline")
      }
    });
    range.addEventListener("input", () => {
      this.selectedIndex = Number(range.value);
      this.stopPlayback();
      this.render();
    });
    player.createSpan({
      text: tr(`${this.selectedIndex + 1} / ${transitions.length} 次关系变化`, `${this.selectedIndex + 1} / ${transitions.length} relation changes`)
    });
  }

  private renderStage(
    container: HTMLElement,
    transition: KnowledgeGraphTransition
  ): void {
    const stage = container.createDiv({
      cls: "git-note-history-graph-machine-stage"
    });
    const top = stage.createDiv({
      cls: "git-note-history-graph-machine-stage-top"
    });
    const identity = top.createDiv();
    identity.createDiv({
      cls: "git-note-history-graph-machine-stage-time",
      text: formatTime(transition.to.capturedAt)
    });
    identity.createEl("h3", {
      text: `${transition.from.label} → ${transition.to.label}`
    });
    identity.createDiv({
      text: tr(`+${transition.added.length} 新关系 · −${transition.removed.length} 移除`, `+${transition.added.length} new · −${transition.removed.length} removed`)
    });
    const compare = top.createEl("button");
    setIcon(compare.createSpan(), "git-compare-arrows");
    compare.createSpan({ text: tr("查看该次修改", "View this edit") });
    compare.addEventListener("click", () => void this.openTransition(transition));
    this.renderGraph(stage, transition);
    const changes = stage.createDiv({
      cls: "git-note-history-graph-machine-changes"
    });
    this.renderRelationColumn(changes, tr("新增", "Added"), "added", transition.added);
    this.renderRelationColumn(changes, tr("移除", "Removed"), "removed", transition.removed);
  }

  private renderGraph(
    container: HTMLElement,
    transition: KnowledgeGraphTransition
  ): void {
    const changes = [
      ...transition.added.map((relation) => ({ relation, state: "added" })),
      ...transition.removed.map((relation) => ({ relation, state: "removed" }))
    ].slice(0, 24);
    const graph = container.createDiv({
      cls: "git-note-history-graph-machine-canvas"
    });
    const svg = graph.createSvg("svg");
    svg.setAttribute("viewBox", "0 0 760 330");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", tr("该版本边界新增和移除的知识关系", "Relations added and removed at this version boundary"));
    const centerX = 380;
    const centerY = 165;
    changes.forEach(({ relation, state }, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(changes.length, 1) - Math.PI / 2;
      const x = centerX + Math.cos(angle) * 290;
      const y = centerY + Math.sin(angle) * 118;
      const line = svg.createSvg("line");
      line.setAttribute("x1", String(centerX));
      line.setAttribute("y1", String(centerY));
      line.setAttribute("x2", String(x));
      line.setAttribute("y2", String(y));
      line.setAttribute("class", `is-${state}`);
      const circle = svg.createSvg("circle");
      circle.setAttribute("cx", String(x));
      circle.setAttribute("cy", String(y));
      circle.setAttribute("r", "7");
      circle.setAttribute("class", `is-${state}`);
      const label = svg.createSvg("text");
      label.setAttribute("x", String(x));
      label.setAttribute("y", String(y + (y < centerY ? -13 : 22)));
      label.setAttribute("text-anchor", "middle");
      label.textContent = relationLabel(relation).slice(0, 26);
    });
    const center = graph.createDiv({
      cls: "git-note-history-graph-machine-center",
      text: this.file?.basename ?? tr("当前笔记", "This note")
    });
    center.setAttr("aria-hidden", "true");
    if (changes.length >= 24) {
      graph.createDiv({
        cls: "git-note-history-graph-machine-cap",
        text: tr("图中显示前 24 个变化，完整列表见下方", "The graph shows the first 24 changes; the full list is below")
      });
    }
  }

  private renderRelationColumn(
    container: HTMLElement,
    title: string,
    state: "added" | "removed",
    relations: NoteRelation[]
  ): void {
    const column = container.createDiv({
      cls: `git-note-history-graph-machine-column is-${state}`
    });
    const heading = column.createDiv();
    heading.createEl("strong", { text: title });
    heading.createSpan({ text: String(relations.length) });
    if (!relations.length) {
      column.createDiv({ text: tr("无", "None") });
      return;
    }
    for (const relation of relations.slice(0, 30)) {
      const destination = this.resolveRelation(relation);
      const row = column.createEl(destination ? "button" : "div", {
        cls: "git-note-history-graph-machine-relation"
      });
      row.createSpan({ text: state === "added" ? "+" : "−" });
      const text = row.createDiv();
      text.createSpan({ text: relationLabel(relation) });
      text.createEl("small", { text: kindLabel(relation.kind) });
      if (destination) {
        row.addEventListener(
          "click",
          () => void this.app.workspace.getLeaf(true).openFile(destination)
        );
      }
    }
    if (relations.length > 30) {
      column.createDiv({ text: tr(`另有 ${relations.length - 30} 个变化`, `${relations.length - 30} more changes`) });
    }
  }

  private renderEventRail(
    container: HTMLElement,
    transitions: KnowledgeGraphTransition[]
  ): void {
    const section = container.createDiv({
      cls: "git-note-history-graph-machine-events"
    });
    const heading = section.createDiv();
    heading.createEl("h3", { text: tr("关系变化时间轴", "Relation change timeline") });
    heading.createSpan({ text: tr("只列出真正发生变化的版本边界", "Only version boundaries where something changed are listed") });
    transitions.forEach((transition, index) => {
      const row = section.createEl("button", {
        cls: index === this.selectedIndex ? "is-active" : ""
      });
      row.createSpan({ text: formatTime(transition.to.capturedAt) });
      const text = row.createDiv();
      text.createEl("strong", { text: transition.to.label });
      text.createEl("small", {
        text: `+${transition.added.length} · −${transition.removed.length} · ${transition.changedKinds.map(kindLabel).join("、")}`
      });
      row.addEventListener("click", () => {
        this.selectedIndex = index;
        this.stopPlayback();
        this.render();
      });
    });
  }

  private renderWarnings(container: HTMLElement): void {
    if (!this.timeline?.warnings.length) return;
    const warnings = container.createEl("details", {
      cls: "git-note-history-graph-machine-warnings"
    });
    warnings.createEl("summary", {
      text: tr(`${this.timeline.warnings.length} 条读取边界`, `${this.timeline.warnings.length} reading limits`)
    });
    for (const warning of this.timeline.warnings) {
      warnings.createDiv({ text: warning });
    }
  }

  private renderEmpty(
    container: HTMLElement,
    icon: string,
    text: string
  ): void {
    const empty = container.createDiv({
      cls: "git-note-history-graph-machine-empty"
    });
    setIcon(empty.createSpan(), icon);
    empty.createEl("h3", { text });
  }

  private resolveRelation(relation: NoteRelation): TFile | null {
    if (relation.kind === "tag" || relation.kind === "footnote" || !this.file) {
      return null;
    }
    return this.app.metadataCache.getFirstLinkpathDest(
      relation.target,
      this.file.path
    );
  }

  private async openTransition(
    transition: KnowledgeGraphTransition
  ): Promise<void> {
    if (!this.file || !this.timeline) return;
    try {
      const history = await this.plugin.gitClient.loadFileHistory(this.file, 80);
      await this.plugin.openDetail({
        filePath: this.file.path,
        repositoryRoot: history.context.repositoryRoot,
        base: transition.from.reference,
        target: transition.to.reference,
        readOnly: true,
        ...(transition.from.content === undefined
          ? {}
          : { baseContentOverride: transition.from.content }),
        ...(transition.to.content === undefined
          ? {}
          : { targetContentOverride: transition.to.content }),
        initialMode: "impact"
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private startPlayback(total: number): void {
    if (this.playbackTimer !== null) return;
    if (this.selectedIndex >= total - 1) this.selectedIndex = 0;
    this.playbackTimer = window.setInterval(() => {
      if (this.selectedIndex >= total - 1) {
        this.stopPlayback();
        this.render();
        return;
      }
      this.selectedIndex += 1;
      this.render();
    }, 1400);
  }

  private stopPlayback(): void {
    if (this.playbackTimer === null) return;
    window.clearInterval(this.playbackTimer);
    this.playbackTimer = null;
  }
}
