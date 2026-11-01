import {
  ItemView,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type { ReviewAnnotationStatus } from "../annotations/types";
import { locateReviewAnnotation } from "../annotations/review-annotations";
import { ReviewAnnotationModal } from "../ui/review-annotation-modal";
import { ConfirmActionModal } from "../ui/confirm-modal";
import { tr } from "../i18n";

export const GIT_REVIEW_ANNOTATIONS_VIEW_TYPE = "git-review-annotations";

const STATUS_LABEL: Record<ReviewAnnotationStatus, string> = {
  pending: tr("待处理", "Open"),
  resolved: tr("已解决", "Resolved"),
  "wont-fix": tr("无需处理", "No action needed")
};

export class GitReviewAnnotationsView extends ItemView {
  private file: TFile | null = null;
  private content = "";
  private filter: ReviewAnnotationStatus | "all" = "all";
  private loading = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitNoteHistoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_REVIEW_ANNOTATIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return tr("版本批注", "Version notes");
  }

  getIcon(): string {
    return "message-square-text";
  }

  async onOpen(): Promise<void> {
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (event) => {
      if (event.key === "Escape") this.leaf.detach();
    }, { capture: true });
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.path === this.file?.path) void this.refresh();
    }));
    this.render();
  }

  async setFile(file: TFile): Promise<void> {
    this.file = file;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.file) return;
    this.loading = true;
    this.render();
    try {
      this.content = await this.app.vault.read(this.file);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "git-review-annotations-view");
    const header = container.createDiv({ cls: "git-review-annotations-header" });
    const title = header.createDiv();
    title.createDiv({ cls: "git-review-annotations-eyebrow", text: tr("本地审阅层 · 不改正文与 commit", "Local review layer · text and commits unchanged") });
    title.createEl("h2", { text: this.file?.basename ?? tr("版本批注", "Version notes") });
    if (this.file) title.createDiv({ cls: "git-review-annotations-path", text: this.file.path });
    const add = header.createEl("button", {
      cls: "mod-cta",
      text: tr("批注当前版本", "Note on this version"),
      attr: { type: "button" }
    });
    add.disabled = !this.file || this.loading;
    add.addEventListener("click", () => {
      if (this.file) void this.plugin.addWorkingVersionAnnotation(this.file);
    });

    const toolbar = container.createDiv({ cls: "git-review-annotations-toolbar" });
    for (const [value, label] of [
      ["all", tr("全部", "All")],
      ["pending", tr("待处理", "Open")],
      ["resolved", tr("已解决", "Resolved")],
      ["wont-fix", tr("无需处理", "No action needed")]
    ] as const) {
      const button = toolbar.createEl("button", {
        text: label,
        attr: { type: "button", "aria-pressed": String(this.filter === value) }
      });
      button.addEventListener("click", () => {
        this.filter = value;
        this.render();
      });
    }
    const exportButton = toolbar.createEl("button", { text: tr("复制审阅包", "Copy review pack"), attr: { type: "button" } });
    exportButton.addEventListener("click", () => {
      if (this.file) void this.plugin.copyAnnotationReviewPackage(this.file);
    });
    const notesButton = toolbar.createEl("button", { text: tr("同步 Git notes…", "Sync to Git notes…"), attr: { type: "button" } });
    notesButton.addEventListener("click", () => {
      if (!this.file) return;
      new ConfirmActionModal(
        this.app,
        tr("写入专用 Git notes？", "Write to a dedicated Git notes ref?"),
        tr("这不会修改 commit 或笔记正文，但普通 git push 默认不会同步 notes。插件将只写 refs/notes/git-note-history-review，并保留其中非插件内容。", "Commits and note text do not change, but a plain git push does not send notes by default. The plugin writes only refs/notes/git-note-history-review and keeps anything there it did not write."),
        tr("确认写入", "Write"),
        () => this.plugin.syncAnnotationsToGitNotes(this.file!)
      ).open();
    });

    const annotations = this.file
      ? this.plugin.getReviewAnnotations(this.file.path)
        .filter((item) => this.filter === "all" || item.status === this.filter)
      : [];
    if (this.loading) {
      container.createDiv({ cls: "git-review-annotations-empty", text: tr("正在读取笔记与批注…", "Reading the note and its notes…") });
      return;
    }
    if (annotations.length === 0) {
      container.createDiv({
        cls: "git-review-annotations-empty",
        text: this.filter === "all"
          ? tr("还没有批注。可给整个工作区版本，或在编辑器中选中内容块后添加。", "No notes yet. Add one to the whole working version, or select a block in the editor first.")
          : tr("这个状态下没有批注。", "No notes in this state.")
      });
      return;
    }
    const list = container.createDiv({ cls: "git-review-annotations-list" });
    for (const item of annotations) {
      const located = locateReviewAnnotation(item, this.content);
      const card = list.createDiv({ cls: "git-review-annotation-card" });
      card.dataset.status = item.status;
      const meta = card.createDiv({ cls: "git-review-annotation-meta" });
      meta.createSpan({ cls: "git-review-annotation-status", text: STATUS_LABEL[item.status] });
      meta.createSpan({ text: item.versionLabel || item.commitHash.slice(0, 8) });
      meta.createSpan({ text: item.target === "block" ? tr("内容块", "Block") : tr("整个版本", "Whole version") });
      if (located.relocated) meta.createSpan({ cls: "git-review-annotation-relocated", text: tr("已重定位", "Relocated") });
      if (located.unresolved) meta.createSpan({ cls: "git-review-annotation-unresolved", text: tr("原块未找到", "Original block not found") });
      card.createDiv({ cls: "git-review-annotation-comment", text: item.comment });
      if (item.block) {
        const context = card.createEl("pre", { cls: "git-review-annotation-context" });
        context.setText(located.currentBlock?.originalContent ?? item.block.originalContent);
      }
      const actions = card.createDiv({ cls: "git-review-annotation-actions" });
      const edit = actions.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": tr("编辑批注", "Edit note"), type: "button" }
      });
      setIcon(edit, "pencil");
      edit.addEventListener("click", () => {
        new ReviewAnnotationModal(
          this.app,
          item,
          item.target === "block" ? tr("内容块批注", "Block note") : tr("版本批注", "Version note"),
          async (draft) => {
            if (draft) await this.plugin.updateReviewAnnotation(item.id, draft);
            else await this.plugin.deleteReviewAnnotation(item.id);
            await this.refresh();
          }
        ).open();
      });
    }
  }
}
