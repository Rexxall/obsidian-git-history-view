import { App, Modal, Setting } from "obsidian";

export class ConfirmActionModal extends Modal {
  constructor(
    app: App,
    private readonly titleText: string,
    private readonly description: string,
    private readonly confirmText: string,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.titleText);
    this.contentEl.createEl("p", { text: this.description });

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            this.close();
            await this.onConfirm();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
