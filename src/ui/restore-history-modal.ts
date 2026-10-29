import { App, Modal, setIcon } from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import { tr } from "../i18n";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
}

export class RestoreHistoryModal extends Modal {
  constructor(app: App, private readonly plugin: GitNoteHistoryPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ap", "ap-modal", "git-note-history-restore-history-modal");
    this.setTitle(tr("恢复历史与撤销栈", "Restore history and undo stack"));
    const stack = this.plugin.restoreService.getUndoStack();
    const intro = this.contentEl.createDiv({ cls: "git-note-history-restore-history-intro" });
    intro.createEl("strong", { text: tr(`${stack.length} 步可以安全撤销`, `${stack.length} steps can be undone safely`) });
    intro.createSpan({ text: tr(" · 只有内容仍与恢复结果一致时才会自动撤销。", " · Undo runs automatically only while the content still matches the restore result.") });

    const receipts = this.plugin.restoreService.getReceipts();
    if (receipts.length === 0) {
      this.contentEl.createDiv({ cls: "git-note-history-empty", text: tr("还没有恢复记录。", "No restore records yet.") });
      return;
    }
    const list = this.contentEl.createDiv({ cls: "git-note-history-receipt-list" });
    for (const receipt of receipts) {
      const row = list.createDiv({ cls: `git-note-history-receipt is-${receipt.status}` });
      const icon = row.createSpan({ cls: "git-note-history-receipt-icon" });
      setIcon(icon, receipt.status === "undone" ? "undo-2" : "history");
      const body = row.createDiv({ cls: "git-note-history-receipt-body" });
      body.createEl("strong", { text: receipt.label });
      body.createDiv({ cls: "git-note-history-receipt-path", text: receipt.filePath });
      const meta = body.createDiv({ cls: "git-note-history-receipt-meta" });
      meta.createSpan({ text: formatDate(receipt.createdAt) });
      meta.createSpan({ text: receipt.scope });
      if (receipt.sourceLabel) meta.createSpan({ text: receipt.sourceLabel });
      meta.createSpan({ text: receipt.status === "undone" ? tr("已撤销", "Undone") : tr("已应用", "Applied") });
      body.createEl("code", {
        text: `${receipt.beforeFingerprint} → ${receipt.afterFingerprint}`
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
