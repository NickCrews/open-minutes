/**
 * Five-field cron expressions (minute, hour, day of month, month, day of
 * week), in UTC: numbers, `*`, ranges (`1-5`), lists (`0,30`) and steps
 * (`*\/15`, `9-17/2`). Day of week runs 0-6 from Sunday, and 7 is Sunday too.
 * As in standard cron, when both day fields are restricted a day matching
 * either one matches.
 */

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Whether each day field is `*`. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

function parseField(
  text: string,
  { name, min, max }: (typeof FIELDS)[number],
): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Bad cron ${name}: "${text}"`);
    const [, star, from, to, step] = m;
    const lo = star === "*" ? min : Number(from);
    const hi =
      star === "*" ? max : to !== undefined ? Number(to) : step ? max : lo;
    const by = step ? Number(step) : 1;
    if (lo < min || hi > max || lo > hi || by < 1) {
      throw new Error(`Bad cron ${name}: "${text}"`);
    }
    for (let v = lo; v <= hi; v += by) values.add(v);
  }
  return values;
}

/** Parses `expr`, throwing on anything malformed. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`A cron expression has 5 fields: "${expr}"`);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((p, i) =>
    parseField(p, FIELDS[i]!),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: parts[2] === "*",
    anyDayOfWeek: parts[4] === "*",
  };
}

/** Whether `cron` fires in the UTC minute containing `at`. */
function firesAt(cron: Cron, at: Date): boolean {
  if (!cron.minutes.has(at.getUTCMinutes())) return false;
  if (!cron.hours.has(at.getUTCHours())) return false;
  if (!cron.months.has(at.getUTCMonth() + 1)) return false;
  const dom = cron.daysOfMonth.has(at.getUTCDate());
  const dow = cron.daysOfWeek.has(at.getUTCDay());
  if (cron.anyDayOfMonth) return dow;
  if (cron.anyDayOfWeek) return dom;
  return dom || dow;
}

/** Whether `expr` fired in the hour up to `now`: after `now` - 60 min, up to `now`. */
export function firedInPastHour(expr: string, now: Date): boolean {
  const cron = parseCron(expr);
  const minute = new Date(now);
  minute.setUTCSeconds(0, 0);
  for (let i = 0; i < 60; i++) {
    if (firesAt(cron, new Date(minute.getTime() - i * 60_000))) return true;
  }
  return false;
}
