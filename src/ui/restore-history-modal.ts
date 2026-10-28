import { App, Modal, setIcon } from "obsidian";
import type GitNoteHistoryPlugin from "../main";

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
    this.setTitle("恢复历史与撤销栈");
    const stack = this.plugin.restoreService.getUndoStack();
    const intro = this.contentEl.createDiv({ cls: "git-note-history-restore-history-intro" });
    intro.createEl("strong", { text: `${stack.length} 步可以安全撤销` });
    intro.createSpan({ text: " · 只有内容仍与恢复结果一致时才会自动撤销。" });

    const receipts = this.plugin.restoreService.getReceipts();
    if (receipts.length === 0) {
      this.contentEl.createDiv({ cls: "git-note-history-empty", text: "还没有恢复记录。" });
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
      meta.createSpan({ text: receipt.status === "undone" ? "已撤销" : "已应用" });
      body.createEl("code", {
        text: `${receipt.beforeFingerprint} → ${receipt.afterFingerprint}`
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
