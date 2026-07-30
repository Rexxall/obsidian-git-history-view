import { describe, expect, it } from "vitest";
import {
  LOCAL_SNAPSHOT_SCHEMA_VERSION,
  LocalSnapshotStore,
  MAX_LOCAL_SNAPSHOTS_PER_FILE,
  normalizeLocalSnapshots
} from "../src/history-sources/local-snapshots";
import { contentFingerprint } from "../src/history/version-groups";

describe("LocalSnapshotStore", () => {
  it("captures, lists, deduplicates, and removes snapshots", () => {
    const records = {};
    let sequence = 0;
    const store = new LocalSnapshotStore(records, {
      now: () => `2026-07-30T0${sequence + 1}:00:00.000Z`,
      createId: () => `snapshot-${++sequence}`
    });
    const first = store.capture({
      filePath: "Notes/A.md",
      content: "First",
      label: "  Before edit  "
    });
    const duplicate = store.capture({
      filePath: "Notes/A.md",
      content: "First",
      label: "Duplicate label"
    });
    const second = store.capture({
      filePath: "Notes/A.md",
      content: "Second"
    });

    expect(first.created).toBe(true);
    expect(first.record.label).toBe("Before edit");
    expect(duplicate).toEqual({ record: first.record, created: false });
    expect(store.list("Notes/A.md").map((record) => record.id)).toEqual([
      second.record.id,
      first.record.id
    ]);
    expect(store.remove(first.record.id)).toEqual(first.record);
    expect(store.get(first.record.id)).toBeUndefined();
  });

  it("normalizes valid records and rejects tampered content", () => {
    const valid = {
      schemaVersion: LOCAL_SNAPSHOT_SCHEMA_VERSION,
      id: "valid",
      filePath: "Notes/A.md",
      label: "Snapshot",
      capturedAt: "2026-07-30T01:00:00.000Z",
      content: "Valid",
      contentFingerprint: contentFingerprint("Valid")
    };
    expect(normalizeLocalSnapshots({
      valid,
      tampered: {
        ...valid,
        id: "tampered",
        content: "Changed"
      }
    })).toEqual({ valid });
  });

  it("retains only the newest per-file capacity", () => {
    const records = Object.fromEntries(
      Array.from({ length: MAX_LOCAL_SNAPSHOTS_PER_FILE + 3 }, (_, index) => {
        const id = `item-${index}`;
        const content = `content-${index}`;
        return [id, {
          schemaVersion: LOCAL_SNAPSHOT_SCHEMA_VERSION,
          id,
          filePath: "Notes/A.md",
          label: id,
          capturedAt: new Date(Date.UTC(2026, 6, 30, index)).toISOString(),
          content,
          contentFingerprint: contentFingerprint(content)
        }];
      })
    );
    const normalized = normalizeLocalSnapshots(records);
    expect(Object.keys(normalized)).toHaveLength(MAX_LOCAL_SNAPSHOTS_PER_FILE);
    expect(normalized["item-0"]).toBeUndefined();
    expect(normalized[`item-${MAX_LOCAL_SNAPSHOTS_PER_FILE + 2}`]).toBeDefined();
  });

  it("refuses content larger than the per-snapshot limit", () => {
    const store = new LocalSnapshotStore({});
    expect(() => store.capture({
      filePath: "Notes/A.md",
      content: "x".repeat(2 * 1024 * 1024 + 1)
    })).toThrow("笔记超过 2 MB");
  });
});
