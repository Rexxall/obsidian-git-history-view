import { App, Component, MarkdownRenderer, Modal, Setting, TFile, setIcon } from "obsidian";
import { diffLines } from "diff";
import { buildLinkImpact } from "../analysis/link-impact";
import { buildSemanticDiff } from "../diff/semantic-diff";
import type { RestoreScope } from "../models";

export interface RestorePreviewOptions {
  file: TFile;
  title: string;
  currentContent: string;
  targetContent: string;
  label: string;
  sourceLabel?: string;
  scope: RestoreScope;
  confirmText: string;
  onConfirm: () => Promise<void>;
  onSaveCopy?: () => Promise<void>;
}

function lineStats(before: string, after: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const part of diffLines(before, after)) {
    const count = Math.max(0, part.count ?? part.value.split(/\r?\n/).length - 1);
    if (part.added) added += count;
    if (part.removed) deleted += count;
  }
  return { added, deleted };
}

export class RestorePreviewModal extends Modal {
  private readonly renderer = new Component();

  constructor(app: App, private readonly options: RestorePreviewOptions) {
    super(app);
  }

  onOpen(): void {
    this.renderer.load();
    this.modalEl.addClass("git-note-history-restore-preview-modal");
    this.setTitle(this.options.title);
    const intro = this.contentEl.createDiv({ cls: "git-note-history-restore-preflight" });
    const title = intro.createDiv({ cls: "git-note-history-restore-preflight-title" });
    setIcon(title.createSpan(), "shield-check");
    const text = title.createDiv();
    text.createEl("strong", { text: this.options.label });
    text.createDiv({
      text: `${this.options.file.path}${this.options.sourceLabel ? ` · 来源 ${this.options.sourceLabel}` : ""}`
    });

    const stats = lineStats(this.options.currentContent, this.options.targetContent);
    const semantic = buildSemanticDiff(this.options.currentContent, this.options.targetContent);
    const impact = buildLinkImpact(this.options.currentContent, this.options.targetContent);
    const metrics = intro.createDiv({ cls: "git-note-history-restore-metrics" });
    metrics.createSpan({ cls: "is-added", text: `+${stats.added} 行` });
    metrics.createSpan({ cls: "is-removed", text: `−${stats.deleted} 行` });
    metrics.createSpan({ text: `${semantic.length} 个结构变化` });
    metrics.createSpan({
      cls: impact.removed.length > 0 ? "is-warning" : "",
      text: `${impact.removed.length} 个关系将移除`
    });

    if (semantic.length > 0 || impact.removed.length > 0) {
      const checks = this.contentEl.createDiv({ cls: "git-note-history-restore-checks" });
      checks.createEl("h5", { text: "写回前检查" });
      for (const change of semantic.slice(0, 8)) {
        checks.createDiv({
          cls: `git-note-history-restore-check is-${change.kind}`,
          text: `${change.kind === "added" ? "+" : change.kind === "removed" ? "−" : "↔"} ${change.group} · ${change.label}`
        });
      }
      if (semantic.length > 8) checks.createDiv({ text: `另有 ${semantic.length - 8} 项结构变化` });
      for (const relation of impact.removed.slice(0, 6)) {
        checks.createDiv({
          cls: "git-note-history-restore-check is-warning",
          text: `− 将移除 ${relation.kind === "tag" ? "标签" : "关系"}：${relation.label}`
        });
      }
    }

    const result = this.contentEl.createEl("details", { cls: "git-note-history-restore-result" });
    result.createEl("summary", { text: "查看恢复后的完整内容" });
    const preview = result.createDiv({ cls: "markdown-preview-view git-note-history-restore-markdown-preview" });
    void MarkdownRenderer.render(
      this.app,
      this.options.targetContent,
      preview,
      this.options.file.path,
      this.renderer
    );

    const safety = this.contentEl.createDiv({ cls: "git-note-history-restore-safety-note" });
    setIcon(safety.createSpan(), "history");
    safety.createSpan({
      text: "确认后会先保存恢复前内容并生成回执；插件不会修改 HEAD、分支或 Git 暂存区。"
    });

    let cancelButton: HTMLButtonElement | null = null;
    new Setting(this.contentEl)
      .addButton((button) => {
        cancelButton = button.buttonEl;
        button.setButtonText("取消").onClick(() => this.close());
      })
      .addButton((button) => {
        if (!this.options.onSaveCopy) {
          button.buttonEl.hide();
          return;
        }
        button.setButtonText("另存副本").onClick(async () => {
          button.setDisabled(true);
          await this.options.onSaveCopy?.();
          this.close();
        });
      })
      .addButton((button) =>
        button
          .setButtonText(this.options.confirmText)
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            await this.options.onConfirm();
            this.close();
          })
      );

    window.setTimeout(() => cancelButton?.focus(), 0);
  }

  onClose(): void {
    this.renderer.unload();
    this.contentEl.empty();
  }
}
