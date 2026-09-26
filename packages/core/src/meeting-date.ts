// When a meeting happened, as stored: a wall-clock `date` ("2026-06-14") and an
// optional `time` ("19:30:00") in the body's own timezone. See ADR 0003.
//
// Everything here works on those strings directly and never builds a local JS
// Date from them. A wall-clock reading has no instant attached, so any trip
// through the machine's zone (the server's, the browser's) could only shift it —
// the classic "June 14 renders as June 13" bug. Where Intl needs a Date to
// format, we pin both ends to UTC so the fields come back exactly as given.

/** The two columns a meeting's "when" lives in, as drizzle returns them. */
export interface MeetingWhen {
  /** "YYYY-MM-DD" in the body's timezone, or null when unknown. */
  date: string | null;
  /** "HH:MM:SS" in the body's timezone, or null when unknown. */
  time: string | null;
}

/**
 * Validate a calendar date as "YYYY-MM-DD", returning it unchanged, or null if
 * it isn't one (wrong shape, or a day that doesn't exist, like "2026-02-30").
 */
export function parseMeetingDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls an out-of-range day into the next month rather than failing,
  // so the round trip is what rejects Feb 30.
  if (
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() !== m - 1 ||
    utc.getUTCDate() !== d
  )
    return null;
  return match[0];
}

/**
 * Normalize a time of day "HH:MM" or "HH:MM:SS" (24-hour) to the "HH:MM:SS"
 * Postgres returns for a `time` column, or null if it isn't one.
 */
export function parseMeetingTime(value: string): string | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [h, m, s] = [match[1]!, match[2]!, match[3] ?? "00"];
  if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59) return null;
  return `${h}:${m}:${s}`;
}

/** A "YYYY-MM-DD" as the UTC midnight Date that Intl can format without shift. */
function dateAsUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** "2026-06-14" → "June 14, 2026". */
export function formatDate(date: string): string {
  return dateAsUtc(date).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "19:30:00" (or "19:30") → "7:30 PM". */
export function formatTimeOfDay(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(1970, 0, 1, h, m)).toLocaleTimeString("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * A meeting's when, for display: "June 14, 2026 7:30 PM" when the time is known,
 * just "June 14, 2026" when it isn't — never a made-up midnight — and null when
 * even the date is unknown, so each caller picks its own fallback (a "Date
 * unknown" label, or nothing at all).
 */
export function formatMeetingDate(meeting: MeetingWhen): string | null {
  if (!meeting.date) return null;
  const day = formatDate(meeting.date);
  return meeting.time ? `${day} ${formatTimeOfDay(meeting.time)}` : day;
}

/** "2023-04-10" → "Apr 2023". */
export function formatMonthYear(date: string): string {
  return dateAsUtc(date).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    year: "numeric",
  });
}

/**
 * Sort comparator, newest meeting first. Unknown dates sort last; on the same
 * day a known time sorts before an unknown one. The strings compare correctly
 * as-is, being zero-padded and most-significant-first.
 */
export function compareMeetingsNewestFirst(
  a: MeetingWhen,
  b: MeetingWhen,
): number {
  return newestFirst(a.date, b.date) || newestFirst(a.time, b.time);
}

/** Descending order, with nulls after every known value. */
function newestFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : 1;
}
