const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short "how long ago" text for the status bar; older than 30 days falls back to the date. */
export function formatTimeAgo(iso: string, now: number, chinese: boolean): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return chinese ? "刚刚" : "just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return chinese ? `${minutes} 分钟前` : `${minutes} min ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return chinese ? `${hours} 小时前` : `${hours} h ago`;
  }
  if (elapsed < 30 * DAY) {
    const days = Math.floor(elapsed / DAY);
    return chinese ? `${days} 天前` : days === 1 ? "1 day ago" : `${days} days ago`;
  }
  return new Date(time).toISOString().slice(0, 10);
}
