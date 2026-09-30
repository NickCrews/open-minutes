/** Short zone label for a moment, eg "AKDT". */
export function formatZoneAbbreviation(date: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
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
 * The smallest unit a duration spells out. Seconds are informative for a stretch
 * of speech and noise for a meeting that runs hours, so the caller picks.
 */
export type DurationPrecision = "seconds" | "minutes";

/**
 * Format seconds as "1h 23m 5s", or as "1h 23m" at minute precision. Zero
 * leading units are omitted (e.g. "23m 5s", "5s"). The value is rounded to the
 * chosen unit; anything that would round to a bare "0m" reads as "<1m" instead,
 * so a short duration isn't mistaken for a missing one.
 */
export function formatSecsDuration(
  totalSecs: number,
  precision: DurationPrecision = "seconds",
): string {
  if (precision === "minutes") {
    const mins = Math.round(Math.max(0, totalSecs) / 60);
    if (mins === 0) return "<1m";
    const h = Math.floor(mins / 60);
    return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
  }
  const secs = Math.max(0, Math.round(totalSecs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format a Postgres interval string like "01:23:05.023" as "1h 23m 5s", or as
 * "1h 23m" at minute precision. Strings that don't look like an interval are
 * returned unchanged.
 */
export function formatDuration(
  interval: string,
  precision: DurationPrecision = "seconds",
): string {
  const secs = intervalToSecs(interval);
  if (secs == null) return interval;
  return formatSecsDuration(secs, precision);
}
