import { App, Notice, TFile } from "obsidian";
import { contentFingerprint } from "../history/version-groups";
import type {
  RestoreOptions,
  RestoreReceipt,
  UndoSnapshot
} from "../models";

const MAX_UNDO_STEPS = 12;
const MAX_RECEIPTS = 60;

export class ConcurrentNoteChangeError extends Error {
  constructor() {
    super("笔记在恢复期间发生了新修改，已停止恢复以避免覆盖内容。");
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
  setStack: (stack: UndoSnapshot[]) => Promise<void>;
  getReceipts: () => RestoreReceipt[];
  setReceipts: (receipts: RestoreReceipt[]) => Promise<void>;
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
  constructor(
    private readonly app: App,
    private readonly persistence: RestorePersistence
  ) {}

  canUndo(): boolean {
    return this.persistence.getStack().length > 0;
  }

  getUndoStack(): readonly UndoSnapshot[] {
    return this.persistence.getStack();
  }

  getReceipts(): readonly RestoreReceipt[] {
    return this.persistence.getReceipts();
  }

  async restore(
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
      new Notice("当前笔记已经与目标版本相同。");
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

    const previousStack = [...this.persistence.getStack()];
    const previousReceipts = [...this.persistence.getReceipts()];
    const nextStack = [...previousStack, undoSnapshot].slice(-MAX_UNDO_STEPS);
    const nextReceipts = [receipt, ...previousReceipts].slice(0, MAX_RECEIPTS);

    await this.persistence.setStack(nextStack);
    await this.persistence.setReceipts(nextReceipts);
    try {
      await this.app.vault.process(file, (current) => {
        if (current !== before) throw new ConcurrentNoteChangeError();
        return targetContent;
      });
    } catch (error) {
      await this.persistence.setStack(previousStack);
      await this.persistence.setReceipts(previousReceipts);
      throw error;
    }

    new Notice(`已${normalized.label}；可撤销“${normalized.label}”。`, 7000);
    return true;
  }

  async undoLastRestore(): Promise<TFile> {
    const stack = [...this.persistence.getStack()];
    const snapshot = stack.at(-1);
    if (!snapshot) throw new UndoUnavailableError("没有可以撤销的 Git 恢复操作。");

    const file = this.app.vault.getFileByPath(snapshot.filePath);
    if (!file) throw new UndoUnavailableError(`找不到原笔记：${snapshot.filePath}`);

    const current = await this.app.vault.read(file);
    if (current !== snapshot.expectedCurrentContent) {
      throw new UndoUnavailableError(
        `“${snapshot.label}”之后笔记又发生了修改。为避免覆盖新内容，自动撤销已停止；恢复记录仍然保留。`
      );
    }

    await this.app.vault.process(file, (latest) => {
      if (latest !== current) throw new ConcurrentNoteChangeError();
      return snapshot.content;
    });

    stack.pop();
    const receipts = this.persistence.getReceipts().map((receipt) =>
      receipt.id === snapshot.id ? { ...receipt, status: "undone" as const } : receipt
    );
    await this.persistence.setStack(stack);
    await this.persistence.setReceipts(receipts);
    new Notice(`已撤销：${snapshot.label}。`);
    return file;
  }

  async renameFilePath(oldPath: string, newPath: string): Promise<void> {
    let stackChanged = false;
    const stack = this.persistence.getStack().map((snapshot) => {
      if (snapshot.filePath !== oldPath) return snapshot;
      stackChanged = true;
      return { ...snapshot, filePath: newPath };
    });
    let receiptsChanged = false;
    const receipts = this.persistence.getReceipts().map((receipt) => {
      if (receipt.filePath !== oldPath) return receipt;
      receiptsChanged = true;
      return { ...receipt, filePath: newPath };
    });
    if (stackChanged) await this.persistence.setStack(stack);
    if (receiptsChanged) await this.persistence.setReceipts(receipts);
  }
}
