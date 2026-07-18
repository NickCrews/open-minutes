/**
 * Format a Postgres interval string like "01:23:05.023" as "1h 23m 5s".
 * Zero leading units are omitted (e.g. "23m 5s", "5s"). Fractional
 * seconds are rounded. Strings that don't look like an interval are
 * returned unchanged.
 */
/** Format a meeting time like "June 14, 2026 7:30 PM". */
export function formatMeetingTime(date: Date): string {
  const day = date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${day} ${time}`;
}

export function formatDuration(interval: string): string {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(interval);
  if (!match) return interval;
  const totalSecs = Math.round(
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]),
  );
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
