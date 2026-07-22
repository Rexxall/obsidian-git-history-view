export const DEFAULT_TIMELINE_BATCH_SIZE = 40;

export interface TimelineWindow<T> {
  items: T[];
  total: number;
  visible: number;
  remaining: number;
}

export function buildTimelineWindow<T>(items: T[], requested: number): TimelineWindow<T> {
  const total = items.length;
  const visible = Math.min(total, Math.max(0, Math.trunc(requested)));
  return {
    items: items.slice(0, visible),
    total,
    visible,
    remaining: Math.max(0, total - visible)
  };
}

export function expandTimelineLimit(
  current: number,
  total: number,
  batchSize = DEFAULT_TIMELINE_BATCH_SIZE
): number {
  const safeBatch = Math.max(1, Math.trunc(batchSize));
  return Math.min(Math.max(0, total), Math.max(safeBatch, Math.trunc(current) + safeBatch));
}

export function limitHistory<T>(items: T[], maximum: number): { items: T[]; hasMore: boolean } {
  const safeMaximum = Math.max(1, Math.trunc(maximum));
  return {
    items: items.slice(0, safeMaximum),
    hasMore: items.length > safeMaximum
  };
}
