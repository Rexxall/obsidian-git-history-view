import {
  App,
  Modal,
  Setting,
  TextAreaComponent
} from "obsidian";
import type {
  ReviewAnnotation,
  ReviewAnnotationStatus
} from "../annotations/types";
import { tr } from "../i18n";

export interface ReviewAnnotationDraft {
  comment: string;
  status: ReviewAnnotationStatus;
}

export class ReviewAnnotationModal extends Modal {
  private comment: string;
  private status: ReviewAnnotationStatus;
  private saving = false;
  private saveButton?: HTMLButtonElement;
  private commentInput?: TextAreaComponent;

  constructor(
    app: App,
    private readonly current: ReviewAnnotation | undefined,
    private readonly targetDescription: string,
    private readonly onSubmit: (value: ReviewAnnotationDraft | null) => void | Promise<void>
  ) {
    super(app);
    this.comment = current?.comment ?? "";
    this.status = current?.status ?? "pending";
  }

  onOpen(): void {
    this.modalEl.addClass("ap", "ap-modal");
    this.setTitle(this.current ? tr("编辑版本批注", "Edit version note") : tr("添加版本批注", "Add version note"));
    this.contentEl.createDiv({
      cls: "git-review-annotation-target",
      text: this.targetDescription
    });
    new Setting(this.contentEl)
      .setName(tr("审阅意见", "Review comment"))
      .setDesc(tr("只保存在插件数据中，不修改笔记或 commit。", "Saved only in plugin data; the note and commits do not change."))
      .addTextArea((text) => {
        this.commentInput = text;
        text
          .setPlaceholder(tr("写下需要确认、修正或保留的原因…", "Write what needs checking, fixing or keeping, and why…"))
          .setValue(this.comment)
          .onChange((value) => {
            this.comment = value.trim();
            this.updateSaveState();
          });
        text.inputEl.rows = 6;
        text.inputEl.maxLength = 4000;
        window.setTimeout(() => text.inputEl.focus(), 0);
      });
    new Setting(this.contentEl)
      .setName(tr("状态", "Status"))
      .setDesc(tr("批注可在待处理、已解决、无需处理之间流转。", "A note can move between open, resolved and no action needed."))
      .addDropdown((dropdown) => dropdown
        .addOption("pending", tr("待处理", "Open"))
        .addOption("resolved", tr("已解决", "Resolved"))
        .addOption("wont-fix", tr("无需处理", "No action needed"))
        .setValue(this.status)
        .onChange((value) => {
          this.status = value as ReviewAnnotationStatus;
        }));
    new Setting(this.contentEl)
      .addButton((button) => button.setDestructive()
        .setButtonText(tr("删除", "Delete"))
        .setDisabled(!this.current)
        .onClick(() => void this.submit(null)))
      .addButton((button) => {
        button
          .setButtonText(tr("保存批注", "Save note"))
          .setCta()
          .onClick(() => void this.submit({
            comment: this.comment,
            status: this.status
          }));
        this.saveButton = button.buttonEl;
      });
    this.updateSaveState();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updateSaveState(): void {
    if (this.saveButton) {
      this.saveButton.disabled = this.saving || !this.comment;
    }
  }

  private async submit(value: ReviewAnnotationDraft | null): Promise<void> {
    if (this.saving || (value && !value.comment)) return;
    this.saving = true;
    this.updateSaveState();
    try {
      await this.onSubmit(value);
      this.close();
    } finally {
      this.saving = false;
      this.updateSaveState();
    }
  }
}
