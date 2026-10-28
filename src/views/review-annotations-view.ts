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

export const GIT_REVIEW_ANNOTATIONS_VIEW_TYPE = "git-review-annotations";

const STATUS_LABEL: Record<ReviewAnnotationStatus, string> = {
  pending: "待处理",
  resolved: "已解决",
  "wont-fix": "无需处理"
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
    return "版本批注";
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
    title.createDiv({ cls: "git-review-annotations-eyebrow", text: "本地审阅层 · 不改正文与 commit" });
    title.createEl("h2", { text: this.file?.basename ?? "版本批注" });
    if (this.file) title.createDiv({ cls: "git-review-annotations-path", text: this.file.path });
    const add = header.createEl("button", {
      cls: "mod-cta",
      text: "批注当前版本",
      attr: { type: "button" }
    });
    add.disabled = !this.file || this.loading;
    add.addEventListener("click", () => {
      if (this.file) void this.plugin.addWorkingVersionAnnotation(this.file);
    });

    const toolbar = container.createDiv({ cls: "git-review-annotations-toolbar" });
    for (const [value, label] of [
      ["all", "全部"],
      ["pending", "待处理"],
      ["resolved", "已解决"],
      ["wont-fix", "无需处理"]
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
    const exportButton = toolbar.createEl("button", { text: "复制审阅包", attr: { type: "button" } });
    exportButton.addEventListener("click", () => {
      if (this.file) void this.plugin.copyAnnotationReviewPackage(this.file);
    });
    const notesButton = toolbar.createEl("button", { text: "同步 Git notes…", attr: { type: "button" } });
    notesButton.addEventListener("click", () => {
      if (!this.file) return;
      new ConfirmActionModal(
        this.app,
        "写入专用 Git notes？",
        "这不会修改 commit 或笔记正文，但普通 git push 默认不会同步 notes。插件将只写 refs/notes/git-note-history-review，并保留其中非插件内容。",
        "确认写入",
        () => this.plugin.syncAnnotationsToGitNotes(this.file!)
      ).open();
    });

    const annotations = this.file
      ? this.plugin.getReviewAnnotations(this.file.path)
        .filter((item) => this.filter === "all" || item.status === this.filter)
      : [];
    if (this.loading) {
      container.createDiv({ cls: "git-review-annotations-empty", text: "正在读取笔记与批注…" });
      return;
    }
    if (annotations.length === 0) {
      container.createDiv({
        cls: "git-review-annotations-empty",
        text: this.filter === "all"
          ? "还没有批注。可给整个工作区版本，或在编辑器中选中内容块后添加。"
          : "这个状态下没有批注。"
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
      meta.createSpan({ text: item.target === "block" ? "内容块" : "整个版本" });
      if (located.relocated) meta.createSpan({ cls: "git-review-annotation-relocated", text: "已重定位" });
      if (located.unresolved) meta.createSpan({ cls: "git-review-annotation-unresolved", text: "原块未找到" });
      card.createDiv({ cls: "git-review-annotation-comment", text: item.comment });
      if (item.block) {
        const context = card.createEl("pre", { cls: "git-review-annotation-context" });
        context.setText(located.currentBlock?.originalContent ?? item.block.originalContent);
      }
      const actions = card.createDiv({ cls: "git-review-annotation-actions" });
      const edit = actions.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "编辑批注", type: "button" }
      });
      setIcon(edit, "pencil");
      edit.addEventListener("click", () => {
        new ReviewAnnotationModal(
          this.app,
          item,
          item.target === "block" ? "内容块批注" : "版本批注",
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
