import { tr } from "../i18n";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short "how long ago" text for the status bar; older than 30 days falls back to the date. */
export function formatTimeAgo(iso: string, now: number, chinese: boolean): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return chinese ? tr("刚刚", "just now") : "just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return chinese ? tr(`${minutes} 分钟前`, `${minutes} min ago`) : `${minutes} min ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return chinese ? tr(`${hours} 小时前`, `${hours} h ago`) : `${hours} h ago`;
  }
  if (elapsed < 30 * DAY) {
    const days = Math.floor(elapsed / DAY);
    return chinese ? tr(`${days} 天前`, `${days} d ago`) : days === 1 ? "1 day ago" : `${days} days ago`;
  }
  return new Date(time).toISOString().slice(0, 10);
}
