import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { RestoreReceipt, UndoSnapshot } from "../src/models";
import { RestoreService } from "../src/restore/restore-service";

function file(path: string): TFile {
  return { path } as TFile;
}

function snapshot(id: string): UndoSnapshot {
  return {
    id,
    filePath: "Notes/note.md",
    content: `before ${id}`,
    expectedCurrentContent: `after ${id}`,
    createdAt: "2026-07-29T00:00:00.000Z",
    label: id,
    scope: "file"
  };
}

function receipt(id: string): RestoreReceipt {
  return {
    id,
    filePath: "Notes/note.md",
    label: id,
    scope: "file",
    createdAt: "2026-07-29T00:00:00.000Z",
    beforeFingerprint: `before-${id}`,
    afterFingerprint: `after-${id}`,
    status: "applied"
  };
}

function harness(
  initialStack: UndoSnapshot[] = [],
  initialReceipts: RestoreReceipt[] = [],
  failProcess = false,
  failMutationAt = 0
): {
  service: RestoreService;
  stack: () => UndoSnapshot[];
  receipts: () => RestoreReceipt[];
  content: (path: string) => string;
} {
  let stack = structuredClone(initialStack);
  let receipts = structuredClone(initialReceipts);
  let mutationCount = 0;
  const contents = new Map<string, string>([
    ["Notes/note.md", "current"],
    ["Notes/other.md", "other current"]
  ]);
  const app = {
    vault: {
      read: async (file: TFile) => contents.get(file.path) ?? "",
      process: async (
        file: TFile,
        update: (current: string) => string
      ) => {
        if (failProcess) throw new Error("simulated write failure");
        const next = update(contents.get(file.path) ?? "");
        contents.set(file.path, next);
      },
      getFileByPath: (path: string) => file(path)
    }
  };
  const service = new RestoreService(app as never, {
    getStack: () => stack,
    getReceipts: () => receipts,
    mutateHistory: async (mutation, shouldPersist = () => true) => {
      mutationCount += 1;
      if (mutationCount === failMutationAt) {
        throw new Error("simulated history save failure");
      }
      const nextStack = structuredClone(stack);
      const nextReceipts = structuredClone(receipts);
      const result = mutation(nextStack, nextReceipts);
      if (shouldPersist(result)) {
        stack = nextStack;
        receipts = nextReceipts;
      }
      return result;
    }
  });
  return {
    service,
    stack: () => stack,
    receipts: () => receipts,
    content: (path) => contents.get(path) ?? ""
  };
}

describe("restore history transactions", () => {
  it("keeps every old record when a full history restore fails", async () => {
    const oldStack = Array.from({ length: 12 }, (_, index) => snapshot(`old-${index}`));
    const oldReceipts = Array.from({ length: 60 }, (_, index) => receipt(`old-${index}`));
    const test = harness(oldStack, oldReceipts, true);

    await expect(test.service.restore(
      file("Notes/note.md"),
      "target",
      "恢复测试"
    )).rejects.toThrow("simulated write failure");

    expect(test.stack().map((item) => item.id))
      .toEqual(oldStack.map((item) => item.id));
    expect(test.receipts().map((item) => item.id))
      .toEqual(oldReceipts.map((item) => item.id));
  });

  it("trims capacity only after a successful note write", async () => {
    const oldStack = Array.from({ length: 12 }, (_, index) => snapshot(`old-${index}`));
    const oldReceipts = Array.from({ length: 60 }, (_, index) => receipt(`old-${index}`));
    const test = harness(oldStack, oldReceipts);

    await expect(test.service.restore(
      file("Notes/note.md"),
      "target",
      "恢复测试"
    )).resolves.toBe(true);

    expect(test.content("Notes/note.md")).toBe("target");
    expect(test.stack()).toHaveLength(12);
    expect(test.stack()[0]?.id).toBe("old-1");
    expect(test.stack().at(-1)?.label).toBe("恢复测试");
    expect(test.receipts()).toHaveLength(60);
    expect(test.receipts()[0]?.label).toBe("恢复测试");
  });

  it("serializes concurrent restores without losing either undo record", async () => {
    const test = harness();

    await Promise.all([
      test.service.restore(file("Notes/note.md"), "first target", "第一篇"),
      test.service.restore(file("Notes/other.md"), "second target", "第二篇")
    ]);

    expect(test.stack().map((item) => item.label)).toEqual(["第一篇", "第二篇"]);
    expect(test.receipts().map((item) => item.label)).toEqual(["第二篇", "第一篇"]);
  });

  it("restores note content when undo history persistence fails", async () => {
    const undo = snapshot("undo");
    undo.content = "before undo";
    undo.expectedCurrentContent = "current";
    const undoReceipt = receipt("undo");
    const test = harness([undo], [undoReceipt], false, 1);

    await expect(test.service.undoLastRestore())
      .rejects.toThrow("笔记已安全恢复到撤销前内容");

    expect(test.content("Notes/note.md")).toBe("current");
    expect(test.stack().map((item) => item.id)).toEqual(["undo"]);
    expect(test.receipts()[0]?.status).toBe("applied");
  });
});
