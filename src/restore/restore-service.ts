import { App, Notice, TFile } from "obsidian";
import { contentFingerprint } from "../history/version-groups";
import { remapVaultPath } from "../persistence/plugin-data";
import type {
  RestoreOptions,
  RestoreReceipt,
  UndoSnapshot
} from "../models";
import { tr } from "../i18n";

const MAX_UNDO_STEPS = 12;
const MAX_RECEIPTS = 60;

export class ConcurrentNoteChangeError extends Error {
  constructor() {
    super(tr("笔记在恢复期间发生了新修改，已停止恢复以避免覆盖内容。", "The note changed during the restore, so it stopped to avoid overwriting."));
    this.name = "ConcurrentNoteChangeError";
  }
}

export class UndoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndoUnavailableError";
  }
}

interface RestorePersistence {
  getStack: () => UndoSnapshot[];
  getReceipts: () => RestoreReceipt[];
  mutateHistory: <T>(
    mutation: (stack: UndoSnapshot[], receipts: RestoreReceipt[]) => T,
    shouldPersist?: (result: T) => boolean
  ) => Promise<T>;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeOptions(
  options: string | RestoreOptions,
  expectedCurrentContent?: string
): Required<Pick<RestoreOptions, "label" | "scope">> & Omit<RestoreOptions, "label" | "scope"> {
  if (typeof options === "string") {
    return {
      label: options,
      scope: "file",
      ...(expectedCurrentContent === undefined ? {} : { expectedCurrentContent })
    };
  }
  return { scope: options.scope ?? "file", ...options };
}

export class RestoreService {
  private historyOperationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private readonly persistence: RestorePersistence
  ) {}

  private enqueueHistoryOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.historyOperationQueue.then(operation);
    this.historyOperationQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  canUndo(): boolean {
    return this.persistence.getStack().length > 0;
  }

  getUndoStack(): readonly UndoSnapshot[] {
    return this.persistence.getStack();
  }

  getReceipts(): readonly RestoreReceipt[] {
    return this.persistence.getReceipts();
  }

  restore(
    file: TFile,
    targetContent: string,
    options: string | RestoreOptions,
    legacyExpectedCurrentContent?: string
  ): Promise<boolean> {
    return this.enqueueHistoryOperation(() => this.performRestore(
      file,
      targetContent,
      options,
      legacyExpectedCurrentContent
    ));
  }

  private async performRestore(
    file: TFile,
    targetContent: string,
    options: string | RestoreOptions,
    legacyExpectedCurrentContent?: string
  ): Promise<boolean> {
    const normalized = normalizeOptions(options, legacyExpectedCurrentContent);
    const before = await this.app.vault.read(file);
    if (normalized.expectedCurrentContent !== undefined && before !== normalized.expectedCurrentContent) {
      throw new ConcurrentNoteChangeError();
    }
    if (before === targetContent) {
      new Notice(tr("当前笔记已经与目标版本相同。", "The note already matches the target version."));
      return false;
    }

    const id = createId("restore");
    const undoSnapshot: UndoSnapshot = {
      id,
      filePath: file.path,
      content: before,
      expectedCurrentContent: targetContent,
      createdAt: new Date().toISOString(),
      label: normalized.label,
      scope: normalized.scope,
      ...(normalized.sourceLabel ? { sourceLabel: normalized.sourceLabel } : {})
    };
    const receipt: RestoreReceipt = {
      id,
      filePath: file.path,
      label: normalized.label,
      scope: normalized.scope,
      createdAt: undoSnapshot.createdAt,
      beforeFingerprint: contentFingerprint(before),
      afterFingerprint: contentFingerprint(targetContent),
      status: "applied",
      ...(normalized.sourceLabel ? { sourceLabel: normalized.sourceLabel } : {})
    };

    await this.persistence.mutateHistory((stack, receipts) => {
      stack.push(undoSnapshot);
      receipts.unshift(receipt);
    });
    try {
      await this.app.vault.process(file, (current) => {
        if (current !== before) throw new ConcurrentNoteChangeError();
        return targetContent;
      });
    } catch (error) {
      try {
        await this.persistence.mutateHistory((stack, receipts) => {
          const snapshotIndex = stack.findIndex((item) => item.id === id);
          if (snapshotIndex >= 0) stack.splice(snapshotIndex, 1);
          const receiptIndex = receipts.findIndex((item) => item.id === id);
          if (receiptIndex >= 0) receipts.splice(receiptIndex, 1);
        });
      } catch (cleanupError) {
        throw new Error(
          tr(`笔记恢复未完成，且待处理记录清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, `The restore did not finish, and cleaning up the pending record failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        );
      }
      throw error;
    }

    try {
      await this.persistence.mutateHistory((stack, receipts) => {
        let changed = false;
        if (stack.length > MAX_UNDO_STEPS) {
          stack.splice(0, stack.length - MAX_UNDO_STEPS);
          changed = true;
        }
        if (receipts.length > MAX_RECEIPTS) {
          receipts.splice(MAX_RECEIPTS);
          changed = true;
        }
        return changed;
      }, (changed) => changed);
    } catch (error) {
      new Notice(
        tr(`恢复已完成，但旧恢复记录未能整理：${error instanceof Error ? error.message : String(error)}`, `The restore finished, but old restore records could not be tidied: ${error instanceof Error ? error.message : String(error)}`),
        9000
      );
    }

    new Notice(tr(`已${normalized.label}；可撤销“${normalized.label}”。`, `${normalized.label} done; you can undo "${normalized.label}".`), 7000);
    return true;
  }

  undoLastRestore(): Promise<TFile> {
    return this.enqueueHistoryOperation(() => this.performUndoLastRestore());
  }

  private async performUndoLastRestore(): Promise<TFile> {
    const stack = [...this.persistence.getStack()];
    const snapshot = stack.at(-1);
    if (!snapshot) throw new UndoUnavailableError(tr("没有可以撤销的 Git 恢复操作。", "No Git restore to undo."));

    const file = this.app.vault.getFileByPath(snapshot.filePath);
    if (!file) throw new UndoUnavailableError(tr(`找不到原笔记：${snapshot.filePath}`, `Original note not found: ${snapshot.filePath}`));

    const current = await this.app.vault.read(file);
    if (current !== snapshot.expectedCurrentContent) {
      throw new UndoUnavailableError(
        tr(`“${snapshot.label}”之后笔记又发生了修改。为避免覆盖新内容，自动撤销已停止；恢复记录仍然保留。`, `The note changed after "${snapshot.label}". To avoid overwriting new content, automatic undo stopped; the restore record is kept.`)
      );
    }

    await this.app.vault.process(file, (latest) => {
      if (latest !== current) throw new ConcurrentNoteChangeError();
      return snapshot.content;
    });

    try {
      await this.persistence.mutateHistory((latestStack, receipts) => {
        const snapshotIndex = latestStack.findIndex((item) => item.id === snapshot.id);
        if (snapshotIndex >= 0) latestStack.splice(snapshotIndex, 1);
        const receipt = receipts.find((item) => item.id === snapshot.id);
        if (receipt) receipt.status = "undone";
      });
    } catch (historyError) {
      try {
        await this.app.vault.process(file, (latest) => {
          if (latest !== snapshot.content) throw new ConcurrentNoteChangeError();
          return current;
        });
      } catch (compensationError) {
        throw new Error(
          tr(`笔记内容已经撤销，但撤销记录保存失败，且因后续修改无法自动复原：${compensationError instanceof Error ? compensationError.message : String(compensationError)}`, `The note was undone, but saving the undo record failed and later edits prevent restoring it automatically: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`)
        );
      }
      throw new Error(
        tr(`撤销记录保存失败，笔记已安全恢复到撤销前内容：${historyError instanceof Error ? historyError.message : String(historyError)}`, `Saving the undo record failed; the note was safely put back as it was before the undo: ${historyError instanceof Error ? historyError.message : String(historyError)}`)
      );
    }
    new Notice(tr(`已撤销：${snapshot.label}。`, `Undone: ${snapshot.label}.`));
    return file;
  }

  async renameFilePath(
    oldPath: string,
    newPath: string,
    includeDescendants = false
  ): Promise<void> {
    await this.persistence.mutateHistory((stack, receipts) => {
      let changed = false;
      for (const snapshot of stack) {
        const filePath = remapVaultPath(
          snapshot.filePath,
          oldPath,
          newPath,
          includeDescendants
        );
        if (filePath === snapshot.filePath) continue;
        snapshot.filePath = filePath;
        changed = true;
      }
      for (const receipt of receipts) {
        const filePath = remapVaultPath(
          receipt.filePath,
          oldPath,
          newPath,
          includeDescendants
        );
        if (filePath === receipt.filePath) continue;
        receipt.filePath = filePath;
        changed = true;
      }
      return changed;
    }, (changed) => changed);
  }
}
