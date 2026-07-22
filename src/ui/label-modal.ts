import { App, Modal, Setting } from "obsidian";

const PRESETS = ["重要基线", "已审核", "发送前", "已发送", "实验版本", "不可发送"];

export class VersionLabelModal extends Modal {
  private value: string;

  constructor(
    app: App,
    currentValue: string,
    private readonly onSubmit: (value: string) => void | Promise<void>
  ) {
    super(app);
    this.value = currentValue;
  }

  onOpen(): void {
    this.setTitle("版本标签");
    new Setting(this.contentEl)
      .setName("标签")
      .setDesc("标签仅保存在插件本地，不修改 Git commit。")
      .addText((text) => {
        text.setPlaceholder("例如：发送前").setValue(this.value).onChange((value) => {
          this.value = value.trim();
        });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    const presets = this.contentEl.createDiv({ cls: "git-note-history-label-presets" });
    for (const preset of PRESETS) {
      const button = presets.createEl("button", { text: preset });
      button.addEventListener("click", () => {
        this.value = preset;
        void this.submit();
      });
    }

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("移除标签").onClick(() => {
          this.value = "";
          void this.submit();
        })
      )
      .addButton((button) => button.setButtonText("保存").setCta().onClick(() => void this.submit()));
  }

  private async submit(): Promise<void> {
    this.close();
    await this.onSubmit(this.value);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
