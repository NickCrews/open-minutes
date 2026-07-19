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

/** Format seconds as a clock-style timestamp: "0:07", "4:05", "1:02:33". */
export function formatTimestamp(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Parse a Postgres interval string like "01:23:05.023" into total seconds, or null. */
export function intervalToSecs(interval: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(interval);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Format seconds as "1h 23m 5s". Zero leading units are omitted
 * (e.g. "23m 5s", "5s"). Fractional seconds are rounded.
 */
export function formatSecsDuration(totalSecs: number): string {
  const secs = Math.max(0, Math.round(totalSecs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format a Postgres interval string like "01:23:05.023" as "1h 23m 5s".
 * Strings that don't look like an interval are returned unchanged.
 */
export function formatDuration(interval: string): string {
  const secs = intervalToSecs(interval);
  if (secs == null) return interval;
  return formatSecsDuration(secs);
}
