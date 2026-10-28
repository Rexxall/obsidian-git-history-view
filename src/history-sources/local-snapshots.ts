import { contentFingerprint } from "../history/version-groups";

export const LOCAL_SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_LOCAL_SNAPSHOT_CONTENT_BYTES = 2 * 1024 * 1024;
export const MAX_LOCAL_SNAPSHOTS_PER_FILE = 12;
export const MAX_LOCAL_SNAPSHOTS_TOTAL = 96;
export const MAX_LOCAL_SNAPSHOT_TOTAL_BYTES = 12 * 1024 * 1024;

export interface LocalHistorySnapshot {
  schemaVersion: 1;
  id: string;
  filePath: string;
  label: string;
  capturedAt: string;
  content: string;
  contentFingerprint: string;
  sourceModifiedAt?: string;
}

export interface LocalSnapshotCapture {
  filePath: string;
  content: string;
  label?: string;
  sourceModifiedAt?: string;
}

export interface LocalSnapshotStoreOptions {
  now?: () => string;
  createId?: () => string;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedLabel(value: string | undefined): string {
  const trimmed = value?.trim().replace(/\s+/gu, " ") ?? "";
  return (trimmed || "手动快照").slice(0, 80);
}

function recordTime(record: LocalHistorySnapshot): number {
  const value = new Date(record.capturedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function sorted(records: readonly LocalHistorySnapshot[]): LocalHistorySnapshot[] {
  return [...records].sort((left, right) =>
    recordTime(right) - recordTime(left)
    || right.id.localeCompare(left.id)
  );
}

function totalBytes(records: readonly LocalHistorySnapshot[]): number {
  return records.reduce((total, record) => total + byteLength(record.content), 0);
}

export function normalizeLocalSnapshots(
  value: unknown
): Record<string, LocalHistorySnapshot> {
  if (!value || typeof value !== "object") return {};
  const candidates: LocalHistorySnapshot[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Partial<LocalHistorySnapshot>;
    if (
      candidate.schemaVersion !== LOCAL_SNAPSHOT_SCHEMA_VERSION
      || typeof candidate.id !== "string"
      || !candidate.id
      || key !== candidate.id
      || typeof candidate.filePath !== "string"
      || !candidate.filePath
      || typeof candidate.label !== "string"
      || !candidate.label.trim()
      || typeof candidate.capturedAt !== "string"
      || Number.isNaN(new Date(candidate.capturedAt).getTime())
      || typeof candidate.content !== "string"
      || byteLength(candidate.content) > MAX_LOCAL_SNAPSHOT_CONTENT_BYTES
      || typeof candidate.contentFingerprint !== "string"
      || candidate.contentFingerprint !== contentFingerprint(candidate.content)
      || (
        candidate.sourceModifiedAt !== undefined
        && (
          typeof candidate.sourceModifiedAt !== "string"
          || Number.isNaN(new Date(candidate.sourceModifiedAt).getTime())
        )
      )
    ) continue;
    candidates.push({
      schemaVersion: LOCAL_SNAPSHOT_SCHEMA_VERSION,
      id: candidate.id,
      filePath: candidate.filePath,
      label: normalizedLabel(candidate.label),
      capturedAt: new Date(candidate.capturedAt).toISOString(),
      content: candidate.content,
      contentFingerprint: candidate.contentFingerprint,
      ...(candidate.sourceModifiedAt
        ? { sourceModifiedAt: new Date(candidate.sourceModifiedAt).toISOString() }
        : {})
    });
  }

  const retained: LocalHistorySnapshot[] = [];
  const perFile = new Map<string, number>();
  for (const record of sorted(candidates)) {
    if (retained.length >= MAX_LOCAL_SNAPSHOTS_TOTAL) break;
    const fileCount = perFile.get(record.filePath) ?? 0;
    if (fileCount >= MAX_LOCAL_SNAPSHOTS_PER_FILE) continue;
    if (
      totalBytes(retained) + byteLength(record.content)
      > MAX_LOCAL_SNAPSHOT_TOTAL_BYTES
    ) continue;
    retained.push(record);
    perFile.set(record.filePath, fileCount + 1);
  }
  return Object.fromEntries(retained.map((record) => [record.id, record]));
}

export class LocalSnapshotStore {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly records: Record<string, LocalHistorySnapshot>,
    options: LocalSnapshotStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() =>
      (typeof crypto === "undefined" ? undefined : crypto.randomUUID?.())
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    );
  }

  list(filePath?: string): LocalHistorySnapshot[] {
    return sorted(Object.values(this.records).filter(
      (record) => filePath === undefined || record.filePath === filePath
    ));
  }

  get(id: string): LocalHistorySnapshot | undefined {
    const record = this.records[id];
    return record ? { ...record } : undefined;
  }

  capture(input: LocalSnapshotCapture): {
    record: LocalHistorySnapshot;
    created: boolean;
  } {
    if (!input.filePath) throw new Error("快照缺少笔记路径。");
    if (byteLength(input.content) > MAX_LOCAL_SNAPSHOT_CONTENT_BYTES) {
      throw new Error("笔记超过 2 MB，本地快照未创建。");
    }
    const fingerprint = contentFingerprint(input.content);
    const duplicate = this.list(input.filePath).find(
      (record) => record.contentFingerprint === fingerprint
    );
    if (duplicate) return { record: duplicate, created: false };

    const capturedAt = new Date(this.now());
    if (Number.isNaN(capturedAt.getTime())) throw new Error("快照时间无效。");
    const id = this.createId();
    if (!id || this.records[id]) throw new Error("无法生成唯一的快照标识。");
    const record: LocalHistorySnapshot = {
      schemaVersion: LOCAL_SNAPSHOT_SCHEMA_VERSION,
      id,
      filePath: input.filePath,
      label: normalizedLabel(input.label),
      capturedAt: capturedAt.toISOString(),
      content: input.content,
      contentFingerprint: fingerprint,
      ...(input.sourceModifiedAt
        ? { sourceModifiedAt: new Date(input.sourceModifiedAt).toISOString() }
        : {})
    };
    const normalized = normalizeLocalSnapshots({
      ...this.records,
      [record.id]: record
    });
    if (!normalized[record.id]) {
      throw new Error("本地快照已达到容量上限，请先清理旧快照。");
    }
    for (const key of Object.keys(this.records)) delete this.records[key];
    Object.assign(this.records, normalized);
    return { record: { ...record }, created: true };
  }

  remove(id: string): LocalHistorySnapshot | undefined {
    const existing = this.records[id];
    if (!existing) return undefined;
    delete this.records[id];
    return { ...existing };
  }
}
