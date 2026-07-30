import { afterEach, describe, expect, it, vi } from "vitest";
import { traceKnowledgeBoundary } from "../src/knowledge-trace/boundary-search";
import type {
  KnowledgeVersionMaterialization,
  KnowledgeWorkingSnapshot
} from "../src/knowledge-trace/version-materializer";
import type {
  KnowledgeTraceSetupValue
} from "../src/ui/knowledge-trace-modal";
import type {
  KnowledgeTraceViewRun,
  KnowledgeTraceViewServices
} from "../src/views/knowledge-trace-view";

const modalMocks = vi.hoisted(() => {
  class SetupModalMock {
    static readonly instances: SetupModalMock[] = [];

    constructor(
      readonly app: unknown,
      readonly options: {
        onSubmit: (value: KnowledgeTraceSetupValue) => void;
      }
    ) {
      SetupModalMock.instances.push(this);
    }

    open(): void {}
  }

  return { SetupModalMock };
});

vi.mock("obsidian", () => ({
  ItemView: class {},
  Notice: class {},
  TFile: class {},
  WorkspaceLeaf: class {},
  setIcon: vi.fn()
}));

vi.mock("../src/ui/knowledge-trace-modal", () => ({
  KnowledgeTraceSetupModal: modalMocks.SetupModalMock
}));

import { GitKnowledgeTraceView } from "../src/views/knowledge-trace-view";

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

function setup(): KnowledgeTraceSetupValue {
  return {
    filePath: "Notes/Claim.md",
    assertion: {
      kind: "manual",
      prompt: "这版主张仍成立吗？"
    },
    maxVersions: 80
  };
}

function snapshot(): KnowledgeWorkingSnapshot {
  return {
    versionKey: "working",
    filePath: "Notes/Claim.md",
    repositoryPath: "Notes/Claim.md",
    capturedAt: "2026-07-30T00:00:00+09:00",
    branch: "main",
    headHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: " M Notes/Claim.md",
    content: "current",
    fingerprint: "current-fingerprint",
    beforeFingerprint: "current-fingerprint",
    afterFingerprint: "current-fingerprint",
    sizeBytes: 7,
    availability: "ready",
    staleAtCompletion: false
  };
}

function run(): KnowledgeTraceViewRun {
  const traceSetup = setup();
  const samples = [
    {
      key: "old",
      kind: "commit" as const,
      content: "old",
      manualOutcome: "does-not-hold" as const
    },
    {
      key: "working",
      kind: "working" as const,
      content: "current"
    }
  ];
  const materialization: KnowledgeVersionMaterialization = {
    context: {
      vaultRoot: "/repo",
      repositoryRoot: "/repo",
      repositoryRelativePath: "Notes/Claim.md"
    },
    filePath: traceSetup.filePath,
    branch: "main",
    headHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    capturedAt: "2026-07-30T00:00:00+09:00",
    samples,
    versions: samples,
    workingSnapshot: snapshot(),
    limits: {
      maxVersions: 80,
      maxFileBytes: 512 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      maxConcurrency: 4
    },
    hasMoreHistory: false,
    truncated: false,
    materializedBytes: 10,
    warnings: []
  };
  return {
    setup: traceSetup,
    materialization,
    result: traceKnowledgeBoundary({
      assertion: traceSetup.assertion,
      versions: samples
    })
  };
}

function viewFixture(
  services: Partial<KnowledgeTraceViewServices> = {}
): {
  view: GitKnowledgeTraceView;
  render: ReturnType<typeof vi.fn>;
} {
  const render = vi.fn();
  const currentRun = run();
  const view = Object.create(
    GitKnowledgeTraceView.prototype
  ) as GitKnowledgeTraceView;
  Object.assign(view, {
    setup: currentRun.setup,
    run: currentRun,
    loading: false,
    error: "",
    stale: false,
    generation: 3,
    narrow: false,
    traceAbortController: null,
    manualOutcomes: new Map([["old", "does-not-hold"]]),
    manualFocusOverrideKey: "",
    staleCheckGeneration: 0,
    closed: false,
    app: {},
    services: {
      trace: vi.fn(),
      openComparison: vi.fn(),
      ...services
    },
    render
  });
  return { view, render };
}

afterEach(() => {
  modalMocks.SetupModalMock.instances.length = 0;
  vi.unstubAllGlobals();
});

describe("knowledge trace view leases", () => {
  it("never lets a late non-stale check clear a vault event's stale state", async () => {
    const check = deferred<boolean>();
    const { view, render } = viewFixture({
      isFrozenWorkspaceStale: () => check.promise
    });

    const pending = (view as unknown as {
      checkFrozenWorkspaceStale: () => Promise<void>;
    }).checkFrozenWorkspaceStale();
    (view as unknown as {
      markStaleForPath: (path: string) => void;
    }).markStaleForPath("Notes/Claim.md");

    expect(Object.assign({}, view)).toMatchObject({ stale: true });
    check.resolve(false);
    await pending;

    expect(Object.assign({}, view)).toMatchObject({ stale: true });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("ignores a setup modal callback after the view closes", async () => {
    const { view } = viewFixture();
    const setRequest = vi.fn(async () => {});
    Object.assign(view, { setRequest });

    (view as unknown as { openSetup: () => void }).openSetup();
    const modal = modalMocks.SetupModalMock.instances[0];
    expect(modal).toBeDefined();

    await view.onClose();
    modal?.options.onSubmit({
      ...setup(),
      maxVersions: 120
    });
    await Promise.resolve();

    expect(setRequest).not.toHaveBeenCalled();
  });

  it("allows an existing manual judgment to be corrected", () => {
    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    const choice = { focus };
    const querySelector = vi.fn((): typeof choice | null => choice);
    const card = {
      focus: vi.fn(),
      scrollIntoView,
      querySelector
    };
    vi.stubGlobal("window", {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      })
    });
    const { view } = viewFixture();
    Object.assign(view, {
      contentEl: {
        querySelector: vi.fn(() => card)
      }
    });

    (view as unknown as {
      setManualOutcome: (
        versionKey: string,
        outcome: "holds" | "does-not-hold" | "unknown"
      ) => void;
    }).setManualOutcome("working", "holds");
    expect(
      (Object.assign({}, view) as unknown as {
        run: KnowledgeTraceViewRun;
      }).run.result.conclusion
    ).toBe("manual-candidate");

    (view as unknown as {
      setManualOutcome: (
        versionKey: string,
        outcome: "holds" | "does-not-hold" | "unknown"
      ) => void;
    }).setManualOutcome("working", "does-not-hold");

    const state = Object.assign({}, view) as unknown as {
      manualOutcomes: Map<string, string>;
      run: KnowledgeTraceViewRun;
    };
    expect(state.manualOutcomes.get("working")).toBe("does-not-hold");
    expect(state.run.result).toMatchObject({
      conclusion: "stable",
      stableOutcome: "does-not-hold",
      confirmed: false
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    querySelector.mockReturnValue(null);
    (view as unknown as { focusManualCard: () => void }).focusManualCard();
    expect(card.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
