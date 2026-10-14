import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsPhrase,
  type Finding,
  finding,
  isNumberWord,
  isOrdinalWord,
  MONTHS,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "date";

export type DateForm = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * Dates: "March 19", not "March nineteenth", "March 19th", "March nineteen"
 * or "march 19". A month is matched in any case, since the recognizer often
 * writes one in lower case ("born july fourth").
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const next = words[i + 1];
    const month = core(w);
    if (!MONTHS.test(month) || endsPhrase(w) || next === undefined) return;
    const n = core(next);
    // "the February one" is a pronoun, not a day.
    if (/^(the|this|that|next|last)$/i.test(core(words[i - 1] ?? ""))) return;
    const lower = /^\p{Ll}/u.test(month);
    // "may" is a verb as often as a month, and "march" a noun: only an
    // ordinal after one counts, or a numeral after a capitalized one.
    const ambiguous = /^(may|march)$/i.test(month);
    const ordinal = /^\d{1,2}(st|nd|rd|th)$/.test(n) || isOrdinalWord(next);
    const cardinal = isNumberWord(next) && !isOrdinalWord(next);
    const numeral = /^\d{1,2}$/.test(n);
    if (
      ordinal ||
      (cardinal && !ambiguous) ||
      (lower && numeral && (!ambiguous || /^March$/i.test(month)))
    )
      found.push(
        finding(
          i,
          words,
          2,
          `write a date as "March 19": the month capitalized, the day in numerals with no "th"`,
        ),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => DateForm[] = wordRule(code, find);
