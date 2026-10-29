import {
  App,
  Modal,
  Setting,
  TextComponent
} from "obsidian";
import type {
  VersionMilestone,
  VersionMilestoneInput,
  VersionMilestoneKind
} from "../models";
import {
  USER_MILESTONE_PRESETS,
  inferMilestoneKind,
  milestoneKindLabel
} from "../history/milestones";
import { tr } from "../i18n";

function localDateTimeValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export class VersionMilestoneModal extends Modal {
  private kind: VersionMilestoneKind;
  private label: string;
  private note: string;
  private occurredAt: string;
  private occurredAtValid = true;
  private saving = false;
  private labelInput?: TextComponent;
  private saveButton?: HTMLButtonElement;
  private errorEl?: HTMLElement;
  private readonly presetButtons = new Map<VersionMilestoneKind, HTMLButtonElement>();

  constructor(
    app: App,
    private readonly current: VersionMilestone | undefined,
    private readonly onSubmit: (value: VersionMilestoneInput | null) => void | Promise<void>
  ) {
    super(app);
    this.label = current?.label ?? "";
    this.kind = current?.kind ?? inferMilestoneKind(this.label);
    this.note = current?.note ?? "";
    this.occurredAt = current?.occurredAt ?? new Date().toISOString();
  }

  onOpen(): void {
    this.modalEl.addClass("ap", "ap-modal");
    this.setTitle(this.current ? tr("编辑里程碑", "Edit milestone") : tr("命名这个版本", "Name this version"));
    this.contentEl.createDiv({
      cls: "git-note-history-milestone-intro",
      text: tr("用现实中的事件记住重要版本。里程碑只保存在插件本地，不修改笔记或 Git commit。", "Remember important versions by real events. Milestones are kept only in the plugin and never change the note or Git commits.")
    });

    const presets = this.contentEl.createDiv({ cls: "git-note-history-milestone-presets" });
    for (const preset of USER_MILESTONE_PRESETS) {
      const button = presets.createEl("button", {
        text: preset.label,
        attr: {
          type: "button",
          "aria-pressed": String(this.kind === preset.kind)
        }
      });
      this.presetButtons.set(preset.kind, button);
      button.addEventListener("click", () => {
        const previousDefault = milestoneKindLabel(this.kind);
        this.kind = preset.kind;
        if (!this.label || this.label === previousDefault) {
          this.label = preset.kind === "custom" ? "" : preset.label;
          this.labelInput?.setValue(this.label);
        }
        this.updateSelection();
        this.updateSaveState();
        this.labelInput?.inputEl.focus();
      });
    }

    new Setting(this.contentEl)
      .setName(tr("名称", "Name"))
      .setDesc(tr("时间线会优先显示这个名称。", "The timeline shows this name first."))
      .addText((text) => {
        this.labelInput = text;
        text
          .setPlaceholder(tr("例如：发给导师的版本", "For example: version sent to my supervisor"))
          .setValue(this.label)
          .onChange((value) => {
            this.label = value.trim();
            this.updateSaveState();
          });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(this.contentEl)
      .setName(tr("备注", "Note"))
      .setDesc(tr("可选，例如接收人、申请项目或导出用途。", "Optional, for example recipient, application or export purpose."))
      .addText((text) => {
        text
          .setPlaceholder(tr("仅在展开详情和搜索中使用", "Used only in details and search"))
          .setValue(this.note)
          .onChange((value) => {
            this.note = value.trim();
          });
      });

    new Setting(this.contentEl)
      .setName(tr("事件时间", "Event time"))
      .setDesc(tr("例如实际发送、提交或确认的时间，可以补记过去发生的事件。", "When it was actually sent, submitted or confirmed; past events can be added later."))
      .addText((text) => {
        text.inputEl.type = "datetime-local";
        text.inputEl.required = true;
        text.inputEl.setAttribute("aria-required", "true");
        text
          .setValue(localDateTimeValue(this.occurredAt))
          .onChange((value) => {
            const timestamp = new Date(value).getTime();
            this.occurredAtValid = Number.isFinite(timestamp);
            if (this.occurredAtValid) {
              this.occurredAt = new Date(timestamp).toISOString();
            }
            this.errorEl?.setText(
              this.occurredAtValid ? "" : tr("请填写有效的事件时间。", "Enter a valid event time.")
            );
            this.updateSaveState();
          });
      });

    this.errorEl = this.contentEl.createDiv({
      cls: "git-note-history-milestone-error"
    });

    new Setting(this.contentEl)
      .addButton((button) => {
        button
          .setButtonText(tr("移除里程碑", "Remove milestone"))
          .setDisabled(!this.current)
          .onClick(() => void this.submit(null));
      })
      .addButton((button) => {
        button
          .setButtonText(tr("保存里程碑", "Save milestone"))
          .setCta()
          .onClick(() => {
            void this.submit({
              kind: this.kind,
              label: this.label,
              occurredAt: this.occurredAt,
              ...(this.note ? { note: this.note } : {})
            });
          });
        this.saveButton = button.buttonEl;
      });

    this.updateSelection();
    this.updateSaveState();
  }

  private updateSelection(): void {
    for (const [kind, button] of this.presetButtons) {
      button.setAttribute("aria-pressed", String(kind === this.kind));
      button.toggleClass("is-selected", kind === this.kind);
    }
  }

  private updateSaveState(): void {
    if (this.saveButton) {
      this.saveButton.disabled = this.saving
        || this.label.length === 0
        || !this.occurredAtValid;
    }
  }

  private async submit(value: VersionMilestoneInput | null): Promise<void> {
    if (this.saving) return;
    if (value && !this.occurredAtValid) {
      this.errorEl?.setText(tr("请填写有效的事件时间。", "Enter a valid event time."));
      return;
    }
    this.saving = true;
    this.errorEl?.empty();
    this.updateSaveState();
    try {
      await this.onSubmit(value);
      this.close();
    } catch (error) {
      this.saving = false;
      this.updateSaveState();
      this.errorEl?.setText(error instanceof Error ? error.message : String(error));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
