import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsPhrase,
  type Finding,
  finding,
  isNumberWord,
  MONTHS,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "month-capital";

export type MonthCapital = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * A month name in lower case: "July", not "july". Not "may" or "march",
 * which are usually ordinary words, and not a month before a day, which
 * the date rule reports.
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const month = core(w);
    if (!MONTHS.test(month) || !/^\p{Ll}/u.test(month)) return;
    if (/^(may|march)$/.test(month)) return;
    const next = words[i + 1];
    const day =
      next !== undefined &&
      !endsPhrase(w) &&
      (/^\d{1,2}(st|nd|rd|th)?$/.test(core(next)) || isNumberWord(next));
    if (!day)
      found.push(
        finding(
          i,
          words,
          1,
          `capitalize the month: "${month[0]!.toUpperCase()}${month.slice(1)}"`,
        ),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => MonthCapital[] = wordRule(
  code,
  find,
);
