import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsPhrase,
  type Finding,
  finding,
  isNumber,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "time";

export type Time = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/** Times: "7 p.m.", "11:30 a.m.", not "7 PM", "eleven AM", "504 p.m.". */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    if (i === 0) return;
    const prev = words[i - 1]!;
    if (endsPhrase(prev) || !isNumber(prev)) return;
    const c = core(w);
    const meridiem = /^(a\.m|p\.m)$/.test(c)
      ? "ok"
      : /^(AM|PM|am|pm|A\.M|P\.M)$/.test(c) ||
          (/^[ap]$/i.test(c) && /^m\b/i.test(words[i + 1] ?? ""))
        ? "bad"
        : null;
    if (meridiem === "bad")
      found.push(
        finding(
          i - 1,
          words,
          2,
          `write a time as "7 p.m." or "11:30 a.m.", in numerals with "a.m." or "p.m."`,
        ),
      );
    else if (meridiem === "ok" && !/^\d{1,2}(:\d{2})?$/.test(core(prev)))
      found.push(
        finding(
          i - 1,
          words,
          2,
          `write a time in numerals with a colon, as "5:04 p.m." or "11 a.m."`,
        ),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => Time[] = wordRule(code, find);
