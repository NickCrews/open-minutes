// Recover when a meeting happened from the two places it is usually stated:
// the YouTube title ("Girdwood Board of Supervisors Regular Meeting June 15,
// 2026", "Assembly Regular - July 7, 2026 - 2026-07-07 17:00:00") and the chair
// gavelling in at the top of the recording ("...call the meeting to order ...
// June 15th. 7 o'clock.").
//
// Everything here is pure and hand-rolled (regexes plus a little number-word
// arithmetic): the inputs are short and the formats few, so a date library
// would add weight without adding accuracy.
//
// Dates are wall-clock dates in the body's own timezone ("YYYY-MM-DD") and
// times are wall-clock "HH:MM" (24h) — deliberately separate, since either can
// be known without the other.

import type { TranscriptWord } from "@open-minutes/core/transcription";

export interface ParsedMeetingDateTime {
  /** Wall-clock date, "YYYY-MM-DD". */
  date: string;
  /** Wall-clock time, "HH:MM" (24h), or null when none was stated. */
  time: string | null;
  source: "title" | "transcript";
  /** The text the date (and time) was read from, for logs and debugging. */
  evidence: string;
}

export interface ParseOptions {
  /**
   * Year to assume when the text names a month and day but no (valid) year,
   * eg a chair saying just "June 15th". Without it such dates are rejected.
   */
  fallbackYear?: number;
  /**
   * The day the video was published, "YYYY-MM-DD". When there is no year to
   * read or fall back to, a month and day take the latest year in which they
   * fall on or before this day, since a meeting can't be published before it
   * happens: uploaded 2026-01-13, "December 12th" is 2025-12-12.
   */
  uploadDate?: string;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
// Longest first, so "june" wins over "jun" in the alternation.
const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

const UNITS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};
const ORDINAL_UNITS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};

const alt = (words: Iterable<string>) =>
  [...words].sort((a, b) => b.length - a.length).join("|");

// "fifteenth", "twenty first", "twenty-first", "thirty-first".
const ORDINAL_WORD_RE = `(?:(?:twenty|thirty)[\\s-])?(?:${alt(Object.keys(ORDINAL_UNITS))})`;
// Hours as words: "one" .. "twelve".
const HOUR_WORD_RE = alt(UNITS.slice(1, 13));
// Minutes as words: "oh two", "fifteen", "thirty", "forty five", "fifty-nine".
const MINUTE_WORD_RE = `(?:oh[\\s-](?:${alt(UNITS.slice(1, 10))})|(?:${alt(Object.keys(TENS))})(?:[\\s-](?:${alt(UNITS.slice(1, 10))}))?|${alt(UNITS.slice(10))})`;

function ordinalWordToNumber(text: string): number | null {
  const parts = text.toLowerCase().split(/[\s-]+/);
  let total = 0;
  for (const part of parts) {
    if (part in TENS) total += TENS[part]!;
    else if (part in ORDINAL_UNITS) total += ORDINAL_UNITS[part]!;
    else return null;
  }
  return total;
}

/** "seven" → 7, "oh two" → 2, "forty five" → 45, "30" → 30. */
function cardinalToNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  for (const part of text.toLowerCase().split(/[\s-]+/)) {
    if (part === "oh") continue;
    const unit = UNITS.indexOf(part);
    if (unit >= 0) total += unit;
    else if (part in TENS) total += TENS[part]!;
    else return null;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Primitive matchers — each yields every candidate with its position
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
  text: string;
}

interface DateCandidate extends Span {
  year: number | null;
  month: number;
  day: number;
  /** A time that came embedded with the date, eg an ISO "2026-07-07 17:00:00". */
  time: string | null;
}

interface TimeCandidate extends Span {
  time: string;
  /** Weak times (a bare "6:02") only count right next to an anchor. */
  strong: boolean;
}

function* matchAll(re: RegExp, text: string) {
  for (const m of text.matchAll(re)) {
    yield { m, start: m.index, end: m.index + m[0].length, text: m[0] };
  }
}

function normalizeYear(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (raw.length === 2) return 2000 + Number(raw);
  if (raw.length !== 4) return null;
  const year = Number(raw);
  // Rejects title typos like "February 23, 206" rather than inventing a date.
  return year >= 1990 && year <= 2099 ? year : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > daysInMonth(year, month)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// "2026-07-07 17:00:00", "2026-07-07T17:00", "2026-05-20", "2026 05 20".
const ISO_RE =
  /(?<![\d])(\d{4})[-\s](\d{2})[-\s](\d{2})(?:[T\s](\d{2}):(\d{2})(?::\d{2})?)?(?![\d])/g;

function* isoDates(text: string): Generator<DateCandidate> {
  for (const { m, ...span } of matchAll(ISO_RE, text)) {
    const [, y, mo, d, hh, mm] = m;
    const time =
      hh !== undefined && Number(hh) < 24 && Number(mm) < 60
        ? `${hh}:${mm}`
        : null;
    yield {
      ...span,
      year: normalizeYear(y),
      month: Number(mo),
      day: Number(d),
      time,
    };
  }
}

// "June 15, 2026", "June 15th, 2026", "Jun. 15", "May15, 2023",
// "May 13,2023", "March twenty third".
const MONTH_DAY_RE = new RegExp(
  `\\b(${MONTH_RE})(?![a-z])\\.?\\s*` +
    `(?:(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])|the\\s+(${ORDINAL_WORD_RE})|(${ORDINAL_WORD_RE}))\\b` +
    `(?:,?\\s*(\\d{4})(?![\\d:]))?`,
  "gi",
);

function* monthDayDates(text: string): Generator<DateCandidate> {
  for (const { m, ...span } of matchAll(MONTH_DAY_RE, text)) {
    const [, monthName, dayDigits, dayWordThe, dayWord, year] = m;
    // "may" is usually the verb ("we may first consider..."): only the
    // capitalized month counts.
    if (monthName === "may") continue;
    const day =
      dayDigits !== undefined
        ? Number(dayDigits)
        : ordinalWordToNumber((dayWordThe ?? dayWord)!);
    if (day === null) continue;
    yield {
      ...span,
      year: normalizeYear(year),
      month: MONTHS[monthName!.toLowerCase()]!,
      day,
      time: null,
    };
  }
}

// "6/15/26", "9-3-26", "8/6/26", "6 4 26", "11 13 2023" (M D Y, US order).
const NUMERIC_RE =
  /(?<![\d:/.-])(\d{1,2})([/.\s-])(\d{1,2})\2(\d{4}|\d{2})(?![\d:/.-])/g;

function* numericDates(text: string): Generator<DateCandidate> {
  for (const { m, ...span } of matchAll(NUMERIC_RE, text)) {
    const [, mo, , d, y] = m;
    yield {
      ...span,
      year: normalizeYear(y),
      month: Number(mo),
      day: Number(d),
      time: null,
    };
  }
}

const MERIDIEM_RE = `([ap])\\.?\\s?m\\b\\.?`;
const TIME_PATTERNS: Array<{ re: RegExp; strong: boolean }> = [
  // "6:02 p.m.", "7pm", "7 PM", "6:30pm"
  {
    re: new RegExp(
      `(?<![\\d:.])(\\d{1,2})(?::(\\d{2}))?\\s*${MERIDIEM_RE}`,
      "gi",
    ),
    strong: true,
  },
  // "seven p.m.", "six thirty p.m.", "seven oh two pm"
  {
    re: new RegExp(
      `\\b(${HOUR_WORD_RE})(?:[\\s-](${MINUTE_WORD_RE}))?\\s*${MERIDIEM_RE}`,
      "gi",
    ),
    strong: true,
  },
  // "7 o'clock", "seven o'clock", "7 oclock"
  {
    re: new RegExp(
      `(?<![\\d:.])(\\d{1,2}|\\b(?:${HOUR_WORD_RE}))\\s*o[’']?\\s?clock\\b()()`,
      "gi",
    ),
    strong: true,
  },
  // "6:02" with no meridiem
  { re: /(?<![\d:.])(\d{1,2}):(\d{2})(?![\d:])()/g, strong: false },
];

/**
 * Civic bodies meet from morning to evening, so an hour said without a.m./p.m.
 * reads as 8–11 in the morning, noon at 12, and afternoon/evening for 1–7
 * ("seven o'clock" is a 7 p.m. gavel, not a 7 a.m. one).
 */
function assumeMeridiem(hour: number): number {
  return hour >= 1 && hour <= 7 ? hour + 12 : hour;
}

function* times(text: string): Generator<TimeCandidate> {
  for (const { re, strong } of TIME_PATTERNS) {
    for (const { m, ...span } of matchAll(re, text)) {
      const [, hourRaw, minuteRaw, meridiem] = m;
      let hour = cardinalToNumber(hourRaw!);
      const minute = minuteRaw ? cardinalToNumber(minuteRaw) : 0;
      if (hour === null || minute === null || minute > 59) continue;
      if (meridiem) {
        if (hour < 1 || hour > 12) continue;
        const pm = meridiem.toLowerCase() === "p";
        hour = (hour % 12) + (pm ? 12 : 0);
      } else {
        if (hour > 23) continue;
        if (hour <= 12) hour = assumeMeridiem(hour);
      }
      yield { ...span, time: `${pad2(hour)}:${pad2(minute)}`, strong };
    }
  }
}

function resolveDate(
  c: DateCandidate,
  options: ParseOptions,
): { date: string; year: number } | null {
  const year =
    c.year ??
    options.fallbackYear ??
    (options.uploadDate === undefined
      ? null
      : latestYearOnOrBefore(c.month, c.day, options.uploadDate));
  if (year === null) return null;
  const date = formatDate(year, c.month, c.day);
  return date === null ? null : { date, year };
}

// February 29th recurs every 4 years, or 8 across a skipped leap year (2100).
const MAX_YEARS_BACK = 8;

/**
 * The latest year in which `month`/`day` falls on or before `notAfter`
 * ("YYYY-MM-DD"), stepping back a year at a time. Null when `notAfter` is
 * malformed or the day never occurs (eg April 31st).
 */
function latestYearOnOrBefore(
  month: number,
  day: number,
  notAfter: string,
): number | null {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(notAfter);
  if (!m) return null;
  const startYear = Number(m[1]);
  for (let year = startYear; year >= startYear - MAX_YEARS_BACK; year--) {
    const date = formatDate(year, month, day);
    // ISO dates compare correctly as strings.
    if (date !== null && date <= notAfter) return year;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/**
 * Read the meeting date (and, when present, time) from a YouTube title.
 *
 * Formats are tried from most to least machine-like, since the MOA channel's
 * titles carry both a hand-typed English date and a generated ISO timestamp
 * that is right even when the English one has a typo ("Platting Board -
 * February 4, 2025 - 2026-02-04 18:30:00"):
 *   1. ISO: "2026-07-07 17:00:00", "2026-05-20", "2026 05 20"
 *   2. Month name: "June 15, 2026", "June 15th, 2026", "Jun. 15", "May15, 2023"
 *   3. Numeric US order: "6/15/26", "9-3-26", "6 4 26", "11 13 2023"
 * A month with no day ("HHAND Commission Monthly Meeting September 2026")
 * yields null.
 */
export function parseDateFromTitle(
  title: string,
  options: ParseOptions = {},
): ParsedMeetingDateTime | null {
  for (const generator of [isoDates, monthDayDates, numericDates]) {
    for (const candidate of generator(title)) {
      const resolved = resolveDate(candidate, options);
      if (resolved === null) continue;
      let time = candidate.time;
      let evidence = candidate.text;
      if (time === null) {
        // An explicit clock time elsewhere in the title, eg "... 6:30 PM".
        const t = [...times(title)].find((t) => t.strong);
        if (t) {
          time = t.time;
          evidence = `${evidence} … ${t.text}`;
        }
      }
      return { date: resolved.date, time, source: "title", evidence };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** How far into the recording to look for the chair gavelling in. */
export const OPENING_WINDOW_SECS = 10 * 60;

/**
 * The text of the opening minutes of a transcript: all words starting within
 * the first `maxSecs` seconds, space-joined. Later in a meeting, dates are
 * about other things (a hearing "scheduled July 6th", minutes "from April
 * 20th"), so only the opening is worth reading.
 */
export function openingText(
  segments: ReadonlyArray<{ words: TranscriptWord[] }>,
  maxSecs: number = OPENING_WINDOW_SECS,
): string {
  const words: string[] = [];
  for (const segment of segments) {
    for (const word of segment.words) {
      if (word.start <= maxSecs) words.push(word.text);
    }
  }
  return words.join(" ");
}

// Phrases that mark the chair stating the meeting's own date and time. A
// date or time only counts when it sits near one of these.
const ANCHOR_RE =
  /\bto order\b|\b(?:regular|special|this|tonight'?s|today'?s)\s+(?:\w+\s+)?meeting\b|\bmeeting of\b|\b(?:today|tonight) is\b|\bwork session\b/gi;
// "to order" is the gavel itself; the time next to it is the meeting time.
const GAVEL_RE = /\bto order\b/gi;

/** Characters between two spans (0 when they touch or overlap). */
function gap(a: Span, b: Span): number {
  return Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));
}

const DATE_WINDOW_CHARS = 400;
const TIME_WINDOW_CHARS = 300;
// How close a bare "6:02" must be to the gavel (or the stated date) to count.
const WEAK_TIME_WINDOW_CHARS = 60;

function nearest<T extends Span>(
  candidates: T[],
  anchors: Span[],
  window: number,
): T | null {
  let best: T | null = null;
  let bestGap = Infinity;
  for (const c of candidates) {
    for (const a of anchors) {
      const g = gap(c, a);
      if (g <= window && g < bestGap) {
        best = c;
        bestGap = g;
      }
    }
  }
  return best;
}

/**
 * Read the meeting date and meeting time from the opening of a transcript
 * (see {@link openingText}), eg "call to order the regular meeting ... on
 * Tuesday, June 15th, 2026 at 6:02 p.m." or "It's March 23rd, 2026, GBOS
 * regular meeting ... Call the meeting to order seven o'clock."
 *
 * Only dates and times near an anchor phrase ("to order", "regular meeting",
 * "today is", ...) count, so passing mentions of other dates are ignored.
 * Chairs rarely say the year, so pass `fallbackYear` (typically the title's
 * year) or `uploadDate` to accept "June 15th". Returns null when no anchored date is found,
 * even if a time is — a time with no date is not a meeting start.
 */
export function parseDateTimeFromTranscript(
  text: string,
  options: ParseOptions = {},
): ParsedMeetingDateTime | null {
  const anchors = [...matchAll(ANCHOR_RE, text)];
  if (anchors.length === 0) return null;

  const dates = [...monthDayDates(text)].filter(
    (c) => resolveDate(c, options) !== null,
  );
  const dateCandidate = nearest(dates, anchors, DATE_WINDOW_CHARS);
  if (dateCandidate === null) return null;
  const { date } = resolveDate(dateCandidate, options)!;

  const gavels = [...matchAll(GAVEL_RE, text)];
  const all = [...times(text)];
  const timeCandidate =
    nearest(
      all.filter((t) => t.strong),
      [...gavels, dateCandidate],
      TIME_WINDOW_CHARS,
    ) ?? nearest(all, [...gavels, dateCandidate], WEAK_TIME_WINDOW_CHARS);

  const evidenceSpans = [
    dateCandidate,
    ...(timeCandidate ? [timeCandidate] : []),
  ];
  const start = Math.min(...evidenceSpans.map((s) => s.start));
  const end = Math.max(...evidenceSpans.map((s) => s.end));
  return {
    date,
    time: timeCandidate?.time ?? null,
    source: "transcript",
    evidence: text.slice(start, end),
  };
}

// ---------------------------------------------------------------------------
// Combining the two
// ---------------------------------------------------------------------------

export interface MeetingDateTime {
  date: string | null;
  time: string | null;
  dateSource: "title" | "transcript" | null;
  timeSource: "title" | "transcript" | null;
  /** Human-readable notes on where the title and transcript disagree. */
  warnings: string[];
}

// Past this, a title's scheduled time and the gavel time are suspicious.
const TIME_DISAGREEMENT_MINUTES = 60;

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

/**
 * Decide the meeting date and meeting time from its title and the opening of
 * its transcript.
 *
 * - Date: the title's, falling back to the transcript's. Titles are typed by
 *   staff and usually right (and the transcript's year often has to be
 *   borrowed from the title anyway).
 * - Time: the transcript's — the moment the chair gavelled in — falling back
 *   to a scheduled time in the title.
 *
 * Disagreements are kept, not resolved silently: title typos are common
 * ("Regular Meeting June 16, 2026" for a 2025 meeting) and so are
 * misrecognized words, so `warnings` records them for a human to check.
 *
 * Pass the video's `uploadDate` so a date with no year anywhere (a title
 * without a date, a chair saying "March 5th") can still be placed in time.
 */
export function resolveMeetingDateTime(
  title: string,
  transcriptOpening: string,
  options: { uploadDate?: string } = {},
): MeetingDateTime {
  const fromTitle = parseDateFromTitle(title, options);
  const fromTranscript = parseDateTimeFromTranscript(transcriptOpening, {
    ...options,
    fallbackYear: fromTitle ? Number(fromTitle.date.slice(0, 4)) : undefined,
  });

  const warnings: string[] = [];
  if (fromTitle && fromTranscript && fromTitle.date !== fromTranscript.date) {
    warnings.push(
      `title date ${fromTitle.date} ("${fromTitle.evidence}") disagrees with ` +
        `transcript date ${fromTranscript.date} ("${fromTranscript.evidence}")`,
    );
  }
  if (
    fromTitle?.time &&
    fromTranscript?.time &&
    Math.abs(minutesOf(fromTitle.time) - minutesOf(fromTranscript.time)) >
      TIME_DISAGREEMENT_MINUTES
  ) {
    warnings.push(
      `title time ${fromTitle.time} disagrees with transcript time ` +
        `${fromTranscript.time} ("${fromTranscript.evidence}")`,
    );
  }

  const dateFrom = fromTitle ?? fromTranscript;
  const timeFrom = fromTranscript?.time
    ? fromTranscript
    : fromTitle?.time
      ? fromTitle
      : null;
  return {
    date: dateFrom?.date ?? null,
    time: timeFrom?.time ?? null,
    dateSource: dateFrom?.source ?? null,
    timeSource: timeFrom?.source ?? null,
    warnings,
  };
}
