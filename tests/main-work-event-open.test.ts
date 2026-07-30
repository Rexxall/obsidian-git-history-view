import { describe, expect, it, vi } from "vitest";
import type { DetailRequest } from "../src/models";
import type { WorkEventRequest } from "../src/work-events/types";
import type { KnowledgeTraceSetupValue } from "../src/ui/knowledge-trace-modal";

const workEventMocks = vi.hoisted(() => {
  class WorkEventViewMock {
    readonly requests: unknown[] = [];

    async setRequest(request: unknown): Promise<void> {
      this.requests.push(request);
    }
  }

  return { WorkEventViewMock };
});

const detailMocks = vi.hoisted(() => {
  class DetailViewMock {
    readonly requests: unknown[] = [];

    async setRequest(request: unknown): Promise<void> {
      this.requests.push(request);
    }
  }

  return { DetailViewMock };
});

const knowledgeTraceMocks = vi.hoisted(() => {
  class KnowledgeTraceViewMock {
    readonly requests: unknown[] = [];

    async setRequest(request: unknown): Promise<void> {
      this.requests.push(request);
    }
  }

  class KnowledgeTraceSetupModalMock {
    static readonly instances: KnowledgeTraceSetupModalMock[] = [];
    opened = false;

    constructor(
      readonly app: unknown,
      readonly options: {
        onSubmit: (setup: unknown) => void;
      }
    ) {
      KnowledgeTraceSetupModalMock.instances.push(this);
    }

    open(): void {
      this.opened = true;
    }
  }

  return { KnowledgeTraceViewMock, KnowledgeTraceSetupModalMock };
});

const recoveryBasketMocks = vi.hoisted(() => {
  class RecoveryBasketViewMock {
    readonly files: unknown[] = [];

    async setFile(file: unknown): Promise<void> {
      this.files.push(file);
    }
  }

  return { RecoveryBasketViewMock };
});

const historicalSandboxMocks = vi.hoisted(() => {
  class HistoricalSandboxViewMock {
    refreshCount = 0;

    async refresh(): Promise<void> {
      this.refreshCount += 1;
    }
  }

  return { HistoricalSandboxViewMock };
});

vi.mock("obsidian", () => ({
  MarkdownView: class {},
  Notice: class {},
  Plugin: class {},
  TFile: class {},
  TFolder: class {},
  WorkspaceLeaf: class {}
}));
vi.mock("../src/git/git-client", () => ({
  GitClient: class {},
  GitCommandError: class extends Error {}
}));
vi.mock("../src/restore/restore-service", () => ({ RestoreService: class {} }));
vi.mock("../src/settings", () => ({
  DEFAULT_SETTINGS: {},
  GitNoteHistorySettingTab: class {}
}));
vi.mock("../src/views/history-view", () => ({
  GIT_NOTE_HISTORY_VIEW_TYPE: "git-note-history",
  GitNoteHistoryView: class {}
}));
vi.mock("../src/views/knowledge-graph-view", () => ({
  GIT_KNOWLEDGE_GRAPH_VIEW_TYPE: "git-knowledge-graph-time-machine",
  GitKnowledgeGraphView: class {}
}));
vi.mock("../src/views/detail-view", () => ({
  GIT_NOTE_HISTORY_DETAIL_VIEW_TYPE: "git-note-history-detail",
  GitHistoryDetailView: detailMocks.DetailViewMock
}));
vi.mock("../src/views/workspace-review-view", () => ({
  GIT_WORKSPACE_REVIEW_VIEW_TYPE: "git-workspace-review",
  GitWorkspaceReviewView: class {}
}));
vi.mock("../src/ui/line-history-modal", () => ({ LineHistoryModal: class {} }));
vi.mock("../src/views/conflict-resolver-view", () => ({
  GIT_CONFLICT_RESOLVER_VIEW_TYPE: "git-conflict-resolver",
  GitConflictResolverView: class {}
}));
vi.mock("../src/ui/restore-history-modal", () => ({ RestoreHistoryModal: class {} }));
vi.mock("../src/history/version-groups", () => ({ contentFingerprint: vi.fn() }));
vi.mock("../src/history/milestones", () => ({
  clearReviewCheckpointMilestone: vi.fn(),
  projectMilestonesToBookmarks: vi.fn(),
  setReviewCheckpointMilestone: vi.fn()
}));
vi.mock("../src/persistence/plugin-data", () => ({
  CURRENT_DATA_SCHEMA_VERSION: 1,
  migratePluginData: vi.fn(),
  migrateReviewStatePath: vi.fn()
}));
vi.mock("../src/ui/block-age-modal", () => ({ BlockAgeModal: class {} }));
vi.mock("../src/review/review-state", () => ({
  markReviewInboxItemState: vi.fn(),
  setReviewInboxItemSnoozed: vi.fn()
}));
vi.mock("../src/views/work-event-view", () => ({
  GIT_WORK_EVENT_VIEW_TYPE: "git-work-event",
  GitWorkEventView: workEventMocks.WorkEventViewMock
}));
vi.mock("../src/ui/knowledge-trace-modal", () => ({
  KnowledgeTraceSetupModal: knowledgeTraceMocks.KnowledgeTraceSetupModalMock
}));
vi.mock("../src/views/knowledge-trace-view", () => ({
  GIT_KNOWLEDGE_TRACE_VIEW_TYPE: "git-knowledge-trace",
  GitKnowledgeTraceView: knowledgeTraceMocks.KnowledgeTraceViewMock
}));
vi.mock("../src/views/recovery-basket-view", () => ({
  GIT_RECOVERY_BASKET_VIEW_TYPE: "git-recovery-basket",
  GitRecoveryBasketView: recoveryBasketMocks.RecoveryBasketViewMock
}));
vi.mock("../src/views/historical-sandbox-view", () => ({
  GIT_HISTORICAL_SANDBOX_VIEW_TYPE: "git-historical-sandbox",
  GitHistoricalSandboxView: historicalSandboxMocks.HistoricalSandboxViewMock
}));
vi.mock("../src/views/history-source-view", () => ({
  GIT_HISTORY_SOURCE_VIEW_TYPE: "git-history-sources",
  GitHistorySourceView: class {}
}));
vi.mock("../src/knowledge-trace/version-materializer", () => ({
  KnowledgeVersionMaterializer: class {}
}));
vi.mock("../src/knowledge-trace/boundary-search", () => ({
  traceKnowledgeBoundary: vi.fn()
}));

import GitNoteHistoryPlugin from "../src/main";

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

function pluginWithWorkspace(workspace: object): GitNoteHistoryPlugin {
  const plugin = Object.create(GitNoteHistoryPlugin.prototype) as GitNoteHistoryPlugin;
  Object.assign(plugin, {
    app: { workspace },
    detailOpenGeneration: 0,
    pendingDetailLeaf: null,
    workEventOpenGeneration: 0,
    pendingWorkEventLeaf: null,
    knowledgeTraceOpenGeneration: 0,
    pendingKnowledgeTraceLeaf: null,
    recoveryBasketOpenGeneration: 0,
    pendingRecoveryBasketLeaf: null
  });
  return plugin;
}

const firstRequest: WorkEventRequest = {
  anchorVaultPath: "First.md",
  source: { kind: "working" }
};
const latestRequest: WorkEventRequest = {
  anchorVaultPath: "Latest.md",
  source: { kind: "working" }
};

const firstDetailRequest: DetailRequest = {
  filePath: "First.md",
  repositoryRoot: "/vault",
  base: { kind: "working", label: "First base" },
  target: { kind: "working", label: "First target" }
};
const latestDetailRequest: DetailRequest = {
  filePath: "Latest.md",
  repositoryRoot: "/vault",
  base: { kind: "working", label: "Latest base" },
  target: { kind: "working", label: "Latest target" }
};
const firstKnowledgeTraceRequest: KnowledgeTraceSetupValue = {
  filePath: "First.md",
  assertion: {
    kind: "text",
    operator: "contains",
    expected: "first"
  },
  maxVersions: 80
};
const latestKnowledgeTraceRequest: KnowledgeTraceSetupValue = {
  filePath: "Latest.md",
  assertion: {
    kind: "text",
    operator: "contains",
    expected: "latest"
  },
  maxVersions: 80
};

describe("detail view opening", () => {
  it("reuses one pending leaf and applies only the latest concurrent request", async () => {
    const view = new detailMocks.DetailViewMock();
    const viewReady = deferred<void>();
    const leaf = {
      view: null as unknown,
      setViewState: vi.fn(async () => {
        await viewReady.promise;
        leaf.view = view;
      })
    };
    const workspace = {
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => leaf),
      revealLeaf: vi.fn(async () => {})
    };
    const plugin = pluginWithWorkspace(workspace);

    const firstOpen = plugin.openDetail(firstDetailRequest);
    const latestOpen = plugin.openDetail(latestDetailRequest);

    expect(workspace.getLeaf).toHaveBeenCalledTimes(1);
    viewReady.resolve();
    await Promise.all([firstOpen, latestOpen]);

    expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
    expect(view.requests).toEqual([latestDetailRequest]);
  });

  it("does not let an older reveal completion overwrite a newer request", async () => {
    const view = new detailMocks.DetailViewMock();
    const firstReveal = deferred<void>();
    const latestReveal = deferred<void>();
    const revealQueue = [firstReveal, latestReveal];
    const leaf = { view };
    const workspace = {
      getLeavesOfType: vi.fn(() => [leaf]),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(() => revealQueue.shift()?.promise ?? Promise.resolve())
    };
    const plugin = pluginWithWorkspace(workspace);

    const firstOpen = plugin.openDetail(firstDetailRequest);
    await vi.waitFor(() => expect(workspace.revealLeaf).toHaveBeenCalledTimes(1));
    const latestOpen = plugin.openDetail(latestDetailRequest);
    await vi.waitFor(() => expect(workspace.revealLeaf).toHaveBeenCalledTimes(2));

    latestReveal.resolve();
    await latestOpen;
    firstReveal.resolve();
    await firstOpen;

    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(view.requests).toEqual([latestDetailRequest]);
  });

  it("invalidates a pending open when the plugin unloads", async () => {
    const view = new detailMocks.DetailViewMock();
    const viewReady = deferred<void>();
    const leaf = {
      view: null as unknown,
      setViewState: vi.fn(async () => {
        await viewReady.promise;
        leaf.view = view;
      })
    };
    const workspace = {
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => leaf),
      revealLeaf: vi.fn(async () => {}),
      detachLeavesOfType: vi.fn()
    };
    const plugin = pluginWithWorkspace(workspace);

    const pendingOpen = plugin.openDetail(firstDetailRequest);
    plugin.onunload();
    viewReady.resolve();
    await pendingOpen;

    expect(workspace.revealLeaf).not.toHaveBeenCalled();
    expect(view.requests).toEqual([]);
  });
});

describe("recovery-basket view opening", () => {
  it("reuses one pending leaf and applies only the latest note", async () => {
    const rootSplit = {};
    const view = new recoveryBasketMocks.RecoveryBasketViewMock();
    const viewReady = deferred<void>();
    const leaf = {
      view: null as unknown,
      getRoot: () => rootSplit,
      detach: vi.fn(),
      setViewState: vi.fn(async () => {
        await viewReady.promise;
        leaf.view = view;
      })
    };
    const workspace = {
      rootSplit,
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => leaf),
      revealLeaf: vi.fn(async () => {})
    };
    const plugin = pluginWithWorkspace(workspace);
    const first = { path: "First.md", extension: "md" };
    const latest = { path: "Latest.md", extension: "md" };

    const firstOpen = plugin.openRecoveryBasket(first as never);
    const latestOpen = plugin.openRecoveryBasket(latest as never);

    expect(workspace.getLeaf).toHaveBeenCalledTimes(1);
    viewReady.resolve();
    await Promise.all([firstOpen, latestOpen]);

    expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
    expect(view.files).toEqual([latest]);
  });
});

describe("work-event view opening", () => {
  it("reuses one pending leaf and applies only the latest concurrent request", async () => {
    const rootSplit = {};
    const view = new workEventMocks.WorkEventViewMock();
    const viewReady = deferred<void>();
    const leaf = {
      view: null as unknown,
      getRoot: () => rootSplit,
      detach: vi.fn(),
      setViewState: vi.fn(async () => {
        await viewReady.promise;
        leaf.view = view;
      })
    };
    const workspace = {
      rootSplit,
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => leaf),
      revealLeaf: vi.fn(async () => {})
    };
    const plugin = pluginWithWorkspace(workspace);

    const firstOpen = plugin.openWorkEvent(firstRequest);
    const latestOpen = plugin.openWorkEvent(latestRequest);

    expect(workspace.getLeaf).toHaveBeenCalledTimes(1);
    viewReady.resolve();
    await Promise.all([firstOpen, latestOpen]);

    expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
    expect(view.requests).toEqual([latestRequest]);
  });

  it("does not let an older reveal completion overwrite a newer request", async () => {
    const rootSplit = {};
    const view = new workEventMocks.WorkEventViewMock();
    const firstReveal = deferred<void>();
    const latestReveal = deferred<void>();
    const revealQueue = [firstReveal, latestReveal];
    const leaf = {
      view,
      getRoot: () => rootSplit
    };
    const workspace = {
      rootSplit,
      getLeavesOfType: vi.fn(() => [leaf]),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(() => revealQueue.shift()?.promise ?? Promise.resolve())
    };
    const plugin = pluginWithWorkspace(workspace);

    const firstOpen = plugin.openWorkEvent(firstRequest);
    await vi.waitFor(() => expect(workspace.revealLeaf).toHaveBeenCalledTimes(1));
    const latestOpen = plugin.openWorkEvent(latestRequest);
    await vi.waitFor(() => expect(workspace.revealLeaf).toHaveBeenCalledTimes(2));

    latestReveal.resolve();
    await latestOpen;
    firstReveal.resolve();
    await firstOpen;

    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(view.requests).toEqual([latestRequest]);
  });
});

describe("knowledge-trace view opening", () => {
  it("ignores a setup modal submitted after the plugin unloads", async () => {
    knowledgeTraceMocks.KnowledgeTraceSetupModalMock.instances.length = 0;
    const workspace = {
      rootSplit: {},
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {}),
      detachLeavesOfType: vi.fn()
    };
    const plugin = pluginWithWorkspace(workspace);

    plugin.openKnowledgeTraceSetup(
      { path: "First.md" } as Parameters<GitNoteHistoryPlugin["openKnowledgeTraceSetup"]>[0]
    );
    const modal = knowledgeTraceMocks.KnowledgeTraceSetupModalMock.instances[0];
    expect(modal?.opened).toBe(true);

    plugin.onunload();
    modal?.options.onSubmit(firstKnowledgeTraceRequest);
    await Promise.resolve();

    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).not.toHaveBeenCalled();
  });

  it("ignores an older setup modal after a newer setup has opened", async () => {
    knowledgeTraceMocks.KnowledgeTraceSetupModalMock.instances.length = 0;
    const rootSplit = {};
    const view = new knowledgeTraceMocks.KnowledgeTraceViewMock();
    const leaf = {
      view,
      getRoot: () => rootSplit
    };
    const workspace = {
      rootSplit,
      getLeavesOfType: vi.fn(() => [leaf]),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(async () => {})
    };
    const plugin = pluginWithWorkspace(workspace);
    const file = { path: "First.md" } as Parameters<
      GitNoteHistoryPlugin["openKnowledgeTraceSetup"]
    >[0];

    plugin.openKnowledgeTraceSetup(file);
    plugin.openKnowledgeTraceSetup(file);
    const [older, newer] =
      knowledgeTraceMocks.KnowledgeTraceSetupModalMock.instances;

    older?.options.onSubmit(firstKnowledgeTraceRequest);
    await Promise.resolve();
    expect(workspace.revealLeaf).not.toHaveBeenCalled();

    newer?.options.onSubmit(latestKnowledgeTraceRequest);
    await vi.waitFor(() =>
      expect(view.requests).toEqual([latestKnowledgeTraceRequest])
    );
  });

  it("reuses one pending leaf and applies only the latest concurrent request", async () => {
    const rootSplit = {};
    const view = new knowledgeTraceMocks.KnowledgeTraceViewMock();
    const viewReady = deferred<void>();
    const leaf = {
      view: null as unknown,
      getRoot: () => rootSplit,
      setViewState: vi.fn(async () => {
        await viewReady.promise;
        leaf.view = view;
      })
    };
    const workspace = {
      rootSplit,
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => leaf),
      revealLeaf: vi.fn(async () => {})
    };
    const plugin = pluginWithWorkspace(workspace);

    const firstOpen = plugin.openKnowledgeTrace(firstKnowledgeTraceRequest);
    const latestOpen = plugin.openKnowledgeTrace(latestKnowledgeTraceRequest);

    expect(workspace.getLeaf).toHaveBeenCalledTimes(1);
    viewReady.resolve();
    await Promise.all([firstOpen, latestOpen]);

    expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
    expect(view.requests).toEqual([latestKnowledgeTraceRequest]);
  });

  it("does not let an older reveal completion overwrite a newer request", async () => {
    const rootSplit = {};
    const view = new knowledgeTraceMocks.KnowledgeTraceViewMock();
    const firstReveal = deferred<void>();
    const latestReveal = deferred<void>();
    const revealQueue = [firstReveal, latestReveal];
    const leaf = {
      view,
      getRoot: () => rootSplit
    };
    const workspace = {
      rootSplit,
      getLeavesOfType: vi.fn(() => [leaf]),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(() => revealQueue.shift()?.promise ?? Promise.resolve())
    };
    const plugin = pluginWithWorkspace(workspace);

    const firstOpen = plugin.openKnowledgeTrace(firstKnowledgeTraceRequest);
    await vi.waitFor(() => expect(workspace.revealLeaf).toHaveBeenCalledTimes(1));
    const latestOpen = plugin.openKnowledgeTrace(latestKnowledgeTraceRequest);
    await vi.waitFor(() => expect(workspace.revealLeaf).toHaveBeenCalledTimes(2));

    latestReveal.resolve();
    await latestOpen;
    firstReveal.resolve();
    await firstOpen;

    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(view.requests).toEqual([latestKnowledgeTraceRequest]);
  });

  it("invalidates a pending open when the plugin unloads", async () => {
    const rootSplit = {};
    const view = new knowledgeTraceMocks.KnowledgeTraceViewMock();
    const viewReady = deferred<void>();
    const leaf = {
      view: null as unknown,
      getRoot: () => rootSplit,
      detach: vi.fn(),
      setViewState: vi.fn(async () => {
        await viewReady.promise;
        leaf.view = view;
      })
    };
    const workspace = {
      rootSplit,
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => leaf),
      revealLeaf: vi.fn(async () => {}),
      detachLeavesOfType: vi.fn()
    };
    const plugin = pluginWithWorkspace(workspace);

    const pendingOpen = plugin.openKnowledgeTrace(firstKnowledgeTraceRequest);
    plugin.onunload();
    viewReady.resolve();
    await pendingOpen;

    expect(workspace.revealLeaf).not.toHaveBeenCalled();
    expect(view.requests).toEqual([]);
    expect(leaf.detach).toHaveBeenCalledTimes(1);
  });
});
