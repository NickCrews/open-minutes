import type { RuleMeeting, Severity } from "./common";
import {
  core,
  digits,
  endsPhrase,
  type Finding,
  finding,
  isNumber,
  rewrite,
  wordRule,
  wordValue,
  type WrittenForm,
} from "./numbers";

export const code = "time";

export type Time = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/** A clock time in numerals from the words before "a.m." or "p.m.". */
function clock(texts: readonly string[]): string | undefined {
  const cores = texts.map(core);
  if (cores.length === 1) {
    const c = cores[0]!;
    if (/^\d{1,2}(:\d{2})?$/.test(c)) return valid(c);
    // "504" is 5:04.
    if (/^\d{3,4}$/.test(c)) return valid(`${c.slice(0, -2)}:${c.slice(-2)}`);
    const hour = wordValue(c);
    return hour === undefined ? undefined : valid(String(hour));
  }
  // "eleven fifteen", "seven oh five", "11 15".
  const hour = /^\d{1,2}$/.test(cores[0]!) ? cores[0]! : wordValue(cores[0]!);
  const minutes = digits(texts.slice(1));
  if (hour === undefined || minutes === undefined || minutes.length !== 2)
    return undefined;
  return valid(`${hour}:${minutes}`);
}

/** `time` if it is a time of day on a 12-hour clock. */
function valid(time: string): string | undefined {
  const [h, m = "00"] = time.split(":");
  const hour = Number(h);
  return hour >= 1 && hour <= 12 && Number(m) <= 59 && !/^0/.test(h!)
    ? time
    : undefined;
}

/**
 * Times: "7 p.m.", "11:30 a.m.", not "7 PM", "eleven AM", "504 p.m.". The
 * time runs back from the meridiem over up to three numbers ("eleven fifteen
 * AM"), and is fixed only if they all read as one.
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    if (i === 0) return;
    const prev = words[i - 1]!;
    if (endsPhrase(prev) || !isNumber(prev)) return;
    const c = core(w);
    // "a m": the meridiem said as two words.
    const split = /^[ap]$/i.test(c) && /^m\b/i.test(words[i + 1] ?? "");
    const meridiem = /^(a\.m|p\.m)$/.test(c)
      ? "ok"
      : /^(AM|PM|am|pm|A\.M|P\.M)$/.test(c) || split
        ? "bad"
        : null;
    if (meridiem === null) return;
    if (meridiem === "ok" && /^\d{1,2}(:\d{2})?$/.test(core(prev))) return;
    let start = i - 1;
    while (
      start > i - 3 &&
      start > 0 &&
      (isNumber(words[start - 1]!) ||
        core(words[start - 1]!).toLowerCase() === "oh") &&
      !endsPhrase(words[start - 1]!)
    )
      start--;
    const time = clock(words.slice(start, i));
    const end = split ? i + 2 : i + 1;
    const replacement =
      time === undefined ? undefined : [time, /^a/i.test(c) ? "a.m." : "p.m."];
    found.push(
      finding(
        start,
        words,
        end - start,
        meridiem === "bad"
          ? `write a time as "7 p.m." or "11:30 a.m.", in numerals with "a.m." or "p.m."`
          : `write a time in numerals with a colon, as "5:04 p.m." or "11 a.m."`,
        replacement,
      ),
    );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => Time[] = wordRule(code, find);

/** Writes the time as "7 p.m." or "11:30 a.m.". */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly Time[],
) {
  return rewrite(meeting, violations);
}
