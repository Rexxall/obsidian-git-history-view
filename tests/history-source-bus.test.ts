import { describe, expect, it } from "vitest";
import {
  HistorySourceBus,
  providerHandoffProbe
} from "../src/history-sources/history-source-bus";
import type {
  HistorySourceAdapter,
  HistorySourceDescriptor,
  HistorySourceKind,
  HistorySourceVersion
} from "../src/history-sources/types";

function descriptor(kind: HistorySourceKind): HistorySourceDescriptor {
  return {
    kind,
    label: kind,
    description: `${kind} source`,
    access: kind === "sync" ? "handoff" : "direct",
    confidence: kind === "git" ? "exact" : "snapshot",
    capabilities: {
      listVersions: kind !== "sync",
      readContent: kind !== "sync",
      compare: kind !== "sync",
      restore: false,
      capture: kind === "local-snapshot",
      delete: kind === "local-snapshot"
    }
  };
}

function version(
  source: HistorySourceKind,
  id: string,
  capturedAt: string
): HistorySourceVersion {
  return {
    id,
    source,
    label: id,
    capturedAt,
    contentAvailable: true,
    comparisonAvailable: true,
    restoreAvailable: false
  };
}

function adapter(
  kind: HistorySourceKind,
  versions: HistorySourceVersion[]
): HistorySourceAdapter {
  const sourceDescriptor = descriptor(kind);
  return {
    descriptor: sourceDescriptor,
    async probe() {
      return {
        descriptor: sourceDescriptor,
        available: true,
        status: versions.length ? "ready" : "empty",
        summary: `${versions.length}`,
        versions
      };
    }
  };
}

describe("HistorySourceBus", () => {
  it("isolates adapter failures and merges valid versions in reverse chronology", async () => {
    const failedDescriptor = descriptor("file-recovery");
    const bus = new HistorySourceBus([
      adapter("git", [
        version("git", "a", "2026-07-28T09:00:00.000Z"),
        version("git", "b", "2026-07-27T09:00:00.000Z")
      ]),
      adapter("workspace", [
        version("workspace", "current", "2026-07-30T09:00:00.000Z")
      ]),
      {
        descriptor: failedDescriptor,
        async probe() {
          throw new Error("private store unavailable");
        }
      }
    ]);

    const snapshot = await bus.inspect({
      filePath: "Notes/A.md",
      fileName: "A",
      currentContent: "Current"
    });

    expect(snapshot.versions.map((item) => item.id)).toEqual([
      "workspace:current",
      "git:a",
      "git:b"
    ]);
    expect(snapshot.probes.find(
      (probe) => probe.descriptor.kind === "file-recovery"
    )).toMatchObject({
      status: "error",
      available: false,
      error: "private store unavailable"
    });
  });

  it("rejects duplicate source adapters", () => {
    expect(() => new HistorySourceBus([
      adapter("git", []),
      adapter("git", [])
    ])).toThrow("Duplicate history source adapter: git");
  });

  it("drops malformed, duplicate, and cross-source versions", async () => {
    const bus = new HistorySourceBus([
      adapter("local-snapshot", [
        version("local-snapshot", "one", "2026-07-30T08:00:00.000Z"),
        version("local-snapshot", "one", "2026-07-30T07:00:00.000Z"),
        version("git", "wrong-source", "2026-07-30T06:00:00.000Z"),
        version("local-snapshot", "bad-date", "not-a-date")
      ])
    ]);

    const snapshot = await bus.inspect({
      filePath: "Notes/A.md",
      fileName: "A",
      currentContent: ""
    });
    expect(snapshot.versions.map((item) => item.id)).toEqual([
      "local-snapshot:one"
    ]);
  });

  it("keeps provider-managed sources as explicit handoffs", () => {
    const sourceDescriptor = descriptor("sync");
    expect(providerHandoffProbe(
      sourceDescriptor,
      true,
      "Use Obsidian version history."
    )).toEqual({
      descriptor: sourceDescriptor,
      available: true,
      status: "handoff",
      summary: "Use Obsidian version history.",
      versions: []
    });
  });

  it("honors cancellation instead of converting it into a source failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const bus = new HistorySourceBus([adapter("git", [])]);
    await expect(bus.inspect({
      filePath: "Notes/A.md",
      fileName: "A",
      currentContent: ""
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
