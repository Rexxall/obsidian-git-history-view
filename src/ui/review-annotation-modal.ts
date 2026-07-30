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
    this.setTitle(this.current ? "编辑版本批注" : "添加版本批注");
    this.contentEl.createDiv({
      cls: "git-review-annotation-target",
      text: this.targetDescription
    });
    new Setting(this.contentEl)
      .setName("审阅意见")
      .setDesc("只保存在插件数据中，不修改笔记或 commit。")
      .addTextArea((text) => {
        this.commentInput = text;
        text
          .setPlaceholder("写下需要确认、修正或保留的原因…")
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
      .setName("状态")
      .setDesc("批注可在待处理、已解决、无需处理之间流转。")
      .addDropdown((dropdown) => dropdown
        .addOption("pending", "待处理")
        .addOption("resolved", "已解决")
        .addOption("wont-fix", "无需处理")
        .setValue(this.status)
        .onChange((value) => {
          this.status = value as ReviewAnnotationStatus;
        }));
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("删除")
        .setWarning()
        .setDisabled(!this.current)
        .onClick(() => void this.submit(null)))
      .addButton((button) => {
        button
          .setButtonText("保存批注")
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
