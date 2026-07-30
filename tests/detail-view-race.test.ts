import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetailRequest, GitCommitVersion } from "../src/models";

const modalMocks = vi.hoisted(() => ({
  restoreOptions: [] as Array<{
    onConfirm: () => Promise<void>;
    onSaveCopy?: () => Promise<void>;
  }>,
  milestoneCallbacks: [] as Array<(milestone: unknown) => Promise<void>>
}));

vi.mock("obsidian", () => ({
  App: class {},
  FuzzySuggestModal: class {},
  ItemView: class {},
  MarkdownRenderer: { render: vi.fn() },
  Menu: class {},
  Notice: class {},
  TFile: class {},
  TFolder: class {},
  WorkspaceLeaf: class {},
  normalizePath: (path: string) => path,
  setIcon: vi.fn()
}));
vi.mock("../src/ui/restore-preview-modal", () => ({
  RestorePreviewModal: class {
    constructor(_app: unknown, options: (typeof modalMocks.restoreOptions)[number]) {
      modalMocks.restoreOptions.push(options);
    }

    open(): void {}
  }
}));
vi.mock("../src/ui/restore-history-modal", () => ({ RestoreHistoryModal: class {} }));
vi.mock("../src/ui/block-age-modal", () => ({ BlockAgeModal: class {} }));
vi.mock("../src/ui/milestone-modal", () => ({
  VersionMilestoneModal: class {
    constructor(
      _app: unknown,
      _current: unknown,
      onSave: (milestone: unknown) => Promise<void>
    ) {
      modalMocks.milestoneCallbacks.push(onSave);
    }

    open(): void {}
  }
}));

import { GitHistoryDetailView } from "../src/views/detail-view";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function commit(): GitCommitVersion {
  return {
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    shortHash: "aaaaaaa",
    authorName: "Writer",
    authorEmail: "writer@example.com",
    authoredAt: "2026-07-30T00:00:00+09:00",
    subject: "Previous version",
    historicalPath: "Note.md",
    changeType: "M",
    addedLines: 1,
    deletedLines: 1,
    trailers: {}
  };
}

function request(): DetailRequest {
  return {
    filePath: "Note.md",
    repositoryRoot: "/repo",
    base: { kind: "commit", commit: commit() },
    target: { kind: "working", label: "当前工作区" }
  };
}

function detailFixture(read: () => Promise<string> = async () => "current"): {
  view: GitHistoryDetailView;
  request: DetailRequest;
  file: {
    path: string;
    basename: string;
    parent: { path: string };
  };
  restore: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  resolveFileContext: ReturnType<typeof vi.fn>;
  setVersionMilestone: ReturnType<typeof vi.fn>;
} {
  const detailRequest = request();
  const file = {
    path: "Note.md",
    basename: "Note",
    parent: { path: "/" }
  };
  const restore = vi.fn(async () => true);
  const create = vi.fn(async () => file);
  const readSpy = vi.fn(read);
  const resolveFileContext = vi.fn(async () => ({ repositoryRoot: "/repo" }));
  const setVersionMilestone = vi.fn(async () => {});
  const view = Object.create(GitHistoryDetailView.prototype) as GitHistoryDetailView;
  Object.assign(view, {
    request: detailRequest,
    file,
    baseContent: "previous",
    targetContent: "current",
    loading: false,
    generation: 3,
    contentGeneration: 3,
    historyContext: null,
    changeMap: [],
    app: {
      vault: {
        read: readSpy,
        create,
        getAbstractFileByPath: vi.fn(() => null)
      },
      workspace: {
        getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) }))
      }
    },
    plugin: {
      gitClient: { resolveFileContext },
      restoreService: { restore },
      setVersionMilestone,
      refreshOpenViews: vi.fn()
    }
  });
  return {
    view,
    request: detailRequest,
    file,
    restore,
    create,
    read: readSpy,
    resolveFileContext,
    setVersionMilestone
  };
}

describe("detail view content leases", () => {
  beforeEach(() => {
    modalMocks.restoreOptions.length = 0;
    modalMocks.milestoneCallbacks.length = 0;
  });

  it("does not open a restore modal when the comparison changes during the preflight read", async () => {
    const read = deferred<string>();
    const { view } = detailFixture(() => read.promise);

    const restoreAttempt = (view as unknown as {
      confirmFullRestore: () => Promise<void>;
    }).confirmFullRestore();
    Object.assign(view, {
      generation: 4,
      contentGeneration: -1,
      loading: true
    });
    read.resolve("current");
    await restoreAttempt;

    expect(modalMocks.restoreOptions).toHaveLength(0);
  });

  it("invalidates restore and save-copy callbacks after refresh or close", async () => {
    const { view, restore, create } = detailFixture();
    await (view as unknown as {
      confirmFullRestore: () => Promise<void>;
    }).confirmFullRestore();
    const options = modalMocks.restoreOptions[0]!;

    Object.assign(view, {
      generation: 4,
      contentGeneration: -1,
      loading: false
    });
    await options.onConfirm();
    await options.onSaveCopy?.();

    expect(restore).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a hunk callback captured by an older render before reading the file", async () => {
    const { view, request: detailRequest, file, read } = detailFixture();
    Object.assign(view, {
      generation: 4,
      contentGeneration: 4
    });

    await (view as unknown as {
      confirmHunkRestore: (
        content: string,
        hunk: number,
        expected: { request: DetailRequest; file: unknown; generation: number }
      ) => Promise<void>;
    }).confirmHunkRestore("old hunk", 1, {
      request: detailRequest,
      file,
      generation: 3
    });

    expect(read).not.toHaveBeenCalled();
    expect(modalMocks.restoreOptions).toHaveLength(0);
  });

  it("does not save a milestone from a modal whose content lease expired", async () => {
    const { view, resolveFileContext, setVersionMilestone } = detailFixture();
    Object.assign(view, {
      historyContext: { repositoryRoot: "/repo" }
    });
    (view as unknown as {
      openMilestoneEditor: (
        commit: GitCommitVersion,
        current: undefined,
        generation: number
      ) => void;
    }).openMilestoneEditor(commit(), undefined, 3);
    const save = modalMocks.milestoneCallbacks[0]!;

    Object.assign(view, {
      generation: 4,
      contentGeneration: -1,
      loading: false
    });
    await save({
      id: "milestone",
      label: "Submitted",
      kind: "submitted",
      createdAt: "2026-07-30T00:00:00+09:00"
    });

    expect(resolveFileContext).not.toHaveBeenCalled();
    expect(setVersionMilestone).not.toHaveBeenCalled();
  });

  it("opens a frozen read-only comparison after the live note is renamed or deleted", async () => {
    const base = "before frozen content";
    const target = "after frozen content";
    const frozenRequest: DetailRequest = {
      ...request(),
      readOnly: true,
      baseContentOverride: base,
      targetContentOverride: target
    };
    const getContentForReference = vi.fn(async () => {
      throw new Error("frozen comparison must not read Git again");
    });
    const render = vi.fn();
    const view = Object.create(
      GitHistoryDetailView.prototype
    ) as GitHistoryDetailView;
    Object.assign(view, {
      request: frozenRequest,
      file: null,
      baseContent: "",
      targetContent: "",
      loading: false,
      error: "",
      generation: 0,
      contentGeneration: -1,
      changeMap: [],
      currentChangeIndex: 0,
      historyCommits: [],
      historyContext: null,
      historyLoadedFor: "",
      app: {
        vault: {
          getFileByPath: vi.fn(() => null)
        }
      },
      plugin: {
        gitClient: {
          getContentForReference,
          loadFileHistory: vi.fn()
        }
      },
      render
    });

    await (view as unknown as {
      loadComparison: () => Promise<void>;
    }).loadComparison();

    expect(getContentForReference).not.toHaveBeenCalled();
    expect(Object.assign({}, view)).toMatchObject({
      file: null,
      baseContent: base,
      targetContent: target,
      loading: false,
      error: "",
      generation: 1,
      contentGeneration: 1
    });
    expect(render).toHaveBeenCalled();
  });

  it("allows a frozen sandbox comparison to collect into the recovery basket with its sandbox provenance", () => {
    const { view, request: detailRequest } = detailFixture();
    const sandboxSource = {
      versionKey: "sandbox:af14013cc1c494d95163:Note.md",
      label: "历史沙盒 · 82ba8ccb",
      commitHash: "82ba8ccb4f3092a6a093a66a02c62d052d89b41a",
      shortHash: "82ba8ccb",
      historicalPath: "Note.md",
      authoredAt: "2026-07-30T01:05:10+09:00",
      subject: "Historical sandbox change"
    };
    Object.assign(detailRequest, {
      readOnly: true,
      allowRecoveryCollection: true,
      recoverySourceOverride: sandboxSource
    });

    expect((view as unknown as {
      canCollectToRecoveryBasket: () => boolean;
    }).canCollectToRecoveryBasket()).toBe(true);
    expect((view as unknown as {
      recoveryBasketSource: (request: DetailRequest) => typeof sandboxSource;
    }).recoveryBasketSource(detailRequest)).toEqual(sandboxSource);

    delete detailRequest.allowRecoveryCollection;
    expect((view as unknown as {
      canCollectToRecoveryBasket: () => boolean;
    }).canCollectToRecoveryBasket()).toBe(false);
  });
});
