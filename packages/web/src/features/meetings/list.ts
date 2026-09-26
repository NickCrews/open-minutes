/**
 * The pure half of the /meetings list: when a meeting happened, which ones
 * match the current filters, and how they group by month. Kept free of Solid
 * and the router so it can be tested on its own.
 */

/** The fields of a meeting row the list needs to place and filter it. */
export interface ListedMeeting {
  title: string;
  start_time: Date | null;
  body: { id: number; name: string; timezone: string };
}

/**
 * A calendar month, in the timezone of the body that met. `key` sorts
 * chronologically as a string ("2026-06"); the labels are for display.
 */
export interface MeetingMonth {
  key: string;
  /** "June 2026" */
  long: string;
  /** "Jun 2026" */
  short: string;
}

/**
 * When a meeting happened, for sorting — or null if nobody has recorded it yet.
 *
 * This and `meetingMonth` are the only places the list reads the meeting's
 * date, so a change in how it's stored only has to be absorbed here.
 */
export function meetingSortKey(meeting: ListedMeeting): number | null {
  return meeting.start_time?.getTime() ?? null;
}

/**
 * The month a meeting fell in, read in the body's own timezone: a 6pm meeting
 * on the 31st in Anchorage is still that month's meeting, whatever it is in UTC.
 */
export function meetingMonth(meeting: ListedMeeting): MeetingMonth | null {
  const at = meeting.start_time;
  if (!at) return null;
  const timeZone = meeting.body.timezone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const label = (style: "long" | "short") =>
    at.toLocaleDateString("en-US", { timeZone, month: style, year: "numeric" });
  return {
    key: `${year}-${month}`,
    long: label("long"),
    short: label("short"),
  };
}

/** Most recent first; meetings with no date yet sink to the bottom. */
export function sortMeetings<M extends ListedMeeting>(meetings: M[]): M[] {
  return [...meetings].sort((a, b) => {
    const ka = meetingSortKey(a);
    const kb = meetingSortKey(b);
    if (ka === kb) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return kb - ka;
  });
}

export interface MeetingFilters {
  /** Free text; every whitespace-separated word must appear somewhere. */
  q?: string;
  /** Body ids to keep. Empty or absent keeps every body. */
  bodies?: number[];
}

/**
 * The meetings matching `filters`. Search is case-insensitive and matches each
 * word against the title or the body's name, so "budget gbos" finds the
 * borough assembly's budget sessions without typing either one out in full.
 */
export function filterMeetings<M extends ListedMeeting>(
  meetings: M[],
  filters: MeetingFilters,
): M[] {
  const words = (filters.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const bodies = new Set(filters.bodies ?? []);
  return meetings.filter((m) => {
    if (bodies.size && !bodies.has(m.body.id)) return false;
    if (!words.length) return true;
    const haystack = `${m.title} ${m.body.name}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export interface MonthGroup<M> {
  /** Null for the meetings whose date isn't known yet. */
  month: MeetingMonth | null;
  meetings: M[];
}

/**
 * Consecutive runs of already-sorted meetings that share a month. Meetings in
 * different timezones can straddle a month boundary out of order, so a month
 * may in rare cases appear as two neighbouring runs rather than being merged.
 */
export function groupByMonth<M extends ListedMeeting>(
  meetings: M[],
): MonthGroup<M>[] {
  const groups: MonthGroup<M>[] = [];
  for (const meeting of meetings) {
    const month = meetingMonth(meeting);
    const last = groups.at(-1);
    if (last && last.month?.key === month?.key) last.meetings.push(meeting);
    else groups.push({ month, meetings: [meeting] });
  }
  return groups;
}

/**
 * "132 meetings from Jun 2018 to Sep 2026", or "3 of 132 meetings…" when a
 * filter has narrowed the list. The span covers only the dated meetings.
 */
export function summarizeMeetings(
  shown: ListedMeeting[],
  total: number,
): string {
  const noun = total === 1 ? "meeting" : "meetings";
  const count =
    shown.length === total
      ? `${total} ${noun}`
      : `${shown.length} of ${total} ${noun}`;
  const months = sortMeetings(shown)
    .map(meetingMonth)
    .filter((m) => m !== null);
  const latest = months.at(0);
  const earliest = months.at(-1);
  if (!latest || !earliest) return count;
  if (latest.key === earliest.key) return `${count} in ${latest.short}`;
  return `${count} from ${earliest.short} to ${latest.short}`;
}
