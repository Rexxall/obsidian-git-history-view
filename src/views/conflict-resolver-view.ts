import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type { GitConflictVersions } from "../models";
import {
  buildResolvedConflict,
  parseConflictDocument,
  type ConflictChoice,
  type ConflictHunk,
  type ParsedConflictDocument
} from "../conflict/conflict-parser";
import { findBestMatchingBlock } from "../history/markdown-blocks";
import { ConfirmActionModal } from "../ui/confirm-modal";

export const GIT_CONFLICT_RESOLVER_VIEW_TYPE = "git-note-history-conflict-resolver";

type WholeFileChoice = "ancestor" | "ours" | "theirs";

export class GitConflictResolverView extends ItemView {
  private file: TFile | null = null;
  private versions: GitConflictVersions | null = null;
  private document: ParsedConflictDocument | null = null;
  private choices = new Map<number, ConflictChoice>();
  private wholeFileChoice: WholeFileChoice | null = null;
  private loading = false;
  private error = "";
  private applied = false;
  private generation = 0;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GitNoteHistoryPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_CONFLICT_RESOLVER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? `${this.file.basename} · 冲突解决` : "Git 冲突解决";
  }

  getIcon(): string {
    return "git-merge";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async setFile(file: TFile): Promise<void> {
    this.file = file;
    this.choices.clear();
    this.wholeFileChoice = null;
    this.applied = false;
    await this.loadConflict();
  }

  async refresh(): Promise<void> {
    if (this.file && !this.applied) await this.loadConflict();
  }

  private async loadConflict(): Promise<void> {
    if (!this.file) return;
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const versions = await this.plugin.gitClient.getConflictVersions(this.file);
      if (generation !== this.generation) return;
      this.versions = versions;
      this.document = parseConflictDocument(versions.working);
    } catch (error) {
      if (generation !== this.generation) return;
      this.versions = null;
      this.document = null;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("git-note-history-conflict-view");

    const toolbar = container.createDiv({ cls: "git-note-history-conflict-toolbar" });
    const heading = toolbar.createDiv({ cls: "git-note-history-conflict-heading" });
    setIcon(heading.createSpan(), "git-merge");
    const title = heading.createDiv();
    title.createEl("h3", { text: "Markdown 三方冲突解决" });
    if (this.file) title.createDiv({ cls: "git-note-history-file-path", text: this.file.path });

    const refresh = toolbar.createEl("button", { text: "重新读取 Git 冲突" });
    refresh.addEventListener("click", () => void this.loadConflict());

    if (!this.file) {
      container.createDiv({ cls: "git-note-history-empty", text: "请从冲突笔记的时间线打开解决器。" });
      return;
    }
    if (this.loading) {
      container.createDiv({ cls: "git-note-history-loading", text: "正在读取 Git 索引中的共同祖先、本地和远端版本…" });
      return;
    }
    if (this.error || !this.versions || !this.document) {
      container.createEl("pre", { cls: "git-note-history-error", text: this.error || "无法读取冲突版本。" });
      return;
    }

    if (this.applied) {
      const applied = container.createDiv({ cls: "git-note-history-conflict-applied" });
      setIcon(applied.createSpan(), "circle-check-big");
      applied.createSpan({
        text: "冲突文本已写回工作区并保留撤销副本。Git 索引仍是未合并状态，请检查后自行执行 git add。"
      });
    }

    const intro = container.createDiv({ cls: "git-note-history-conflict-intro" });
    intro.createSpan({ text: "上方三栏用于理解完整上下文；下方按冲突块选择结果。插件不会自动暂存、提交或移动 HEAD。" });
    this.renderTriptych(container);

    if (this.document.hunks.length > 0) {
      const section = container.createDiv({ cls: "git-note-history-conflict-hunks" });
      const sectionTitle = section.createDiv({ cls: "git-note-history-conflict-section-title" });
      sectionTitle.createEl("h4", { text: `${this.document.hunks.length} 个冲突块` });
      const progress = sectionTitle.createSpan({ text: `已选择 ${this.choices.size}/${this.document.hunks.length}` });
      progress.setAttribute("aria-live", "polite");
      for (const hunk of this.document.hunks) this.renderHunk(section, hunk);
    } else {
      this.renderWholeFileChoice(container);
    }
    this.renderResult(container);
  }

  private renderTriptych(container: HTMLElement): void {
    if (!this.versions || !this.file) return;
    const columns = container.createDiv({ cls: "git-note-history-conflict-triptych" });
    this.renderVersionColumn(columns, "共同祖先", "git-branch", this.versions.ancestor, "ancestor");
    this.renderVersionColumn(columns, "本地版本", "laptop", this.versions.ours, "ours");
    this.renderVersionColumn(columns, "远端版本", "cloud", this.versions.theirs, "theirs");
  }

  private renderVersionColumn(
    container: HTMLElement,
    label: string,
    icon: string,
    content: string,
    state: string
  ): void {
    if (!this.file) return;
    const column = container.createDiv({ cls: `git-note-history-conflict-column is-${state}` });
    const header = column.createDiv({ cls: "git-note-history-conflict-column-title" });
    setIcon(header.createSpan(), icon);
    header.createSpan({ text: label });
    const body = column.createDiv({ cls: "git-note-history-conflict-column-body markdown-preview-view" });
    if (content) void MarkdownRenderer.render(this.app, content, body, this.file.path, this);
    else body.createDiv({ cls: "git-note-history-empty", text: "这个阶段没有文件内容。" });
  }

  private renderHunk(container: HTMLElement, hunk: ConflictHunk): void {
    if (!this.versions || !this.file) return;
    const card = container.createDiv({ cls: "git-note-history-conflict-hunk" });
    const header = card.createDiv({ cls: "git-note-history-conflict-hunk-header" });
    header.createSpan({ text: `冲突 ${hunk.id}` });
    header.createSpan({ cls: "git-note-history-conflict-hunk-label", text: hunk.label });

    let ancestor = hunk.ancestor;
    if (!ancestor && this.versions.ancestor) {
      const source = hunk.ours || hunk.theirs;
      const match = findBestMatchingBlock(
        { content: source, headingPath: [], kind: "paragraph" },
        this.versions.ancestor
      );
      if (match && match.score >= 0.35) ancestor = match.block.content;
    }

    const panes = card.createDiv({ cls: "git-note-history-conflict-hunk-panes" });
    this.renderHunkPane(panes, "祖先", ancestor, "ancestor");
    this.renderHunkPane(panes, "本地", hunk.ours, "ours");
    this.renderHunkPane(panes, "远端", hunk.theirs, "theirs");

    const actions = card.createDiv({ cls: "git-note-history-conflict-choice-row" });
    if (hunk.ancestor) this.addChoiceButton(actions, hunk.id, "ancestor", "采用祖先");
    this.addChoiceButton(actions, hunk.id, "ours", "采用本地");
    this.addChoiceButton(actions, hunk.id, "theirs", "采用远端");
    this.addChoiceButton(actions, hunk.id, "both", "两者都保留");
  }

  private renderHunkPane(container: HTMLElement, label: string, content: string, state: string): void {
    const pane = container.createDiv({ cls: `git-note-history-conflict-hunk-pane is-${state}` });
    pane.createDiv({ cls: "git-note-history-conflict-hunk-pane-label", text: label });
    const pre = pane.createEl("pre");
    pre.setText(content || "（空内容）");
  }

  private addChoiceButton(
    container: HTMLElement,
    hunkId: number,
    choice: ConflictChoice,
    label: string
  ): void {
    const button = container.createEl("button", {
      cls: this.choices.get(hunkId) === choice ? "is-active" : "",
      text: label,
      attr: { "aria-pressed": String(this.choices.get(hunkId) === choice) }
    });
    button.addEventListener("click", () => {
      this.choices.set(hunkId, choice);
      this.render();
    });
  }

  private renderWholeFileChoice(container: HTMLElement): void {
    const card = container.createDiv({ cls: "git-note-history-conflict-whole-choice" });
    card.createEl("h4", { text: "没有检测到工作区冲突标记" });
    card.createEl("p", {
      text: "Git 索引仍报告冲突。可能是删除/新增冲突，或冲突标记已被手工清除；请选择要写入的完整版本。"
    });
    const actions = card.createDiv({ cls: "git-note-history-conflict-choice-row" });
    for (const [choice, label] of [
      ["ancestor", "采用完整祖先"],
      ["ours", "采用完整本地"],
      ["theirs", "采用完整远端"]
    ] as const) {
      const button = actions.createEl("button", {
        cls: this.wholeFileChoice === choice ? "is-active" : "",
        text: label
      });
      button.addEventListener("click", () => {
        this.wholeFileChoice = choice;
        this.render();
      });
    }
  }

  private resolvedContent(): string {
    if (!this.versions || !this.document) return "";
    if (this.document.hunks.length > 0) return buildResolvedConflict(this.document, this.choices);
    if (this.wholeFileChoice === "ancestor") return this.versions.ancestor;
    if (this.wholeFileChoice === "ours") return this.versions.ours;
    if (this.wholeFileChoice === "theirs") return this.versions.theirs;
    return this.versions.working;
  }

  private isFullyResolved(): boolean {
    if (!this.document) return false;
    return this.document.hunks.length > 0
      ? this.choices.size === this.document.hunks.length
      : this.wholeFileChoice !== null;
  }

  private renderResult(container: HTMLElement): void {
    if (!this.file || !this.versions || !this.document) return;
    const result = container.createDiv({ cls: "git-note-history-conflict-result" });
    const header = result.createDiv({ cls: "git-note-history-conflict-result-header" });
    header.createEl("h4", { text: "合并结果预览" });
    const ready = this.isFullyResolved();
    header.createSpan({ cls: ready ? "is-ready" : "", text: ready ? "可以安全写回" : "仍有冲突块未选择" });
    const content = this.resolvedContent();
    const preview = result.createDiv({ cls: "git-note-history-conflict-result-preview markdown-preview-view" });
    if (ready) void MarkdownRenderer.render(this.app, content, preview, this.file.path, this);
    else preview.createEl("pre", { text: content });

    const apply = result.createEl("button", { cls: "mod-cta", text: "写回工作区并保留撤销" });
    apply.disabled = !ready || this.applied;
    apply.addEventListener("click", () => this.confirmApply(content));
  }

  private confirmApply(content: string): void {
    if (!this.file || !this.versions || !this.isFullyResolved()) return;
    const file = this.file;
    const expected = this.versions.working;
    new ConfirmActionModal(
      this.app,
      "写回冲突解决结果？",
      "只会替换当前 Markdown 文件并保存一次撤销副本。Git 索引不会自动暂存，写回后仍需检查并自行 git add。",
      "写回结果",
      async () => {
        try {
          const changed = await this.plugin.restoreService.restore(
            file,
            content,
            {
              label: "写回 Git Markdown 冲突解决结果",
              sourceLabel: "共同祖先 / 本地 / 远端",
              scope: "conflict",
              expectedCurrentContent: expected
            }
          );
          if (changed) {
            this.applied = true;
            this.plugin.refreshOpenViews();
            this.render();
          }
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        }
      }
    ).open();
  }
}
