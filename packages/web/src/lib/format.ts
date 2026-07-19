/**
 * Format a meeting time like "June 14, 2026 7:30 PM", in the timezone the body
 * meets in — a meeting reads the same to everyone, whatever zone the browser
 * (or the server rendering the page) happens to be in.
 */
export function formatMeetingTime(date: Date, timeZone: string): string {
  const day = date.toLocaleDateString("en-US", {
    timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${day} ${time}`;
}

/**
 * The wall-clock time `date` shows in `timeZone`, as the "YYYY-MM-DDTHH:mm"
 * that `<input type="datetime-local">` wants.
 */
export function toZonedInputValue(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * Inverse of `toZonedInputValue`: the instant at which `timeZone`'s clocks read
 * `value` (a "YYYY-MM-DDTHH:mm" from a datetime-local input). Returns null if
 * the string isn't a time we can place.
 *
 * There's no direct "wall clock in a zone → instant" API, so we guess that the
 * wall time is UTC and correct by the zone's offset. The offset itself depends
 * on the instant (DST), so the corrected guess is fed back through once. That
 * second pass settles every time except the hour that doesn't exist on a
 * spring-forward date, which lands on the hour after the jump.
 */
export function zonedInputValueToDate(
  value: string,
  timeZone: string,
): Date | null {
  // Date.parse is lenient enough to read the leftovers of a garbage input as a
  // date (it takes "" here, via ":00Z", as the year 2000), so the shape has to
  // be checked before parsing. Seconds are optional: some browsers include them.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(value);
  if (!match) return null;
  const asUtc = Date.parse(`${match[1]}${match[2] ?? ":00"}Z`);
  if (Number.isNaN(asUtc)) return null;
  const once = asUtc - zoneOffsetMs(new Date(asUtc), timeZone);
  const twice = asUtc - zoneOffsetMs(new Date(once), timeZone);
  return new Date(twice);
}

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

/** How far ahead of UTC `timeZone` is at `date`, in milliseconds. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const wallAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return wallAsUtc - date.getTime();
}

/** The zero-padded calendar fields `date` shows in `timeZone`. */
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;
  // en-US with hour12: false renders midnight as hour 24; the rest of the
  // calendar fields are already the next day's, so only the hour needs fixing.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
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
