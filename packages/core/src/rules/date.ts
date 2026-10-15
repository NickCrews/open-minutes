import type { RuleMeeting, Severity } from "./common";
import {
  cardinal,
  core,
  endsPhrase,
  type Finding,
  finding,
  isNumberWord,
  isOrdinalWord,
  MONTHS,
  rewrite,
  TENS,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "date";

export type DateForm = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/** "march" as "March". */
export function capitalized(month: string): string {
  return month[0]!.toUpperCase() + month.slice(1).toLowerCase();
}

/**
 * Dates: "March 19", not "March nineteenth", "March 19th", "March nineteen"
 * or "march 19". A month is matched in any case, since the recognizer often
 * writes one in lower case ("born july fourth"). A day said as two words
 * ("March twenty first") is reported whole.
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
    const after = words[i + 2];
    // "twenty first": a tens word and the ones after it.
    const twoWords =
      n.toLowerCase() in TENS &&
      !endsPhrase(next) &&
      after !== undefined &&
      isNumberWord(after);
    const day = twoWords ? [next, after!] : [next];
    const ordinal =
      /^\d{1,2}(st|nd|rd|th)$/.test(n) || isOrdinalWord(day.at(-1)!);
    const cardinalDay = isNumberWord(next) && !isOrdinalWord(day.at(-1)!);
    const numeral = /^\d{1,2}$/.test(n);
    if (
      !(
        ordinal ||
        (cardinalDay && !ambiguous) ||
        (lower && numeral && (!ambiguous || /^March$/i.test(month)))
      )
    )
      return;
    const value = /^\d/.test(n)
      ? Number(n.replace(/\D+$/, ""))
      : cardinal(day)?.value;
    found.push(
      finding(
        i,
        words,
        1 + day.length,
        `write a date as "March 19": the month capitalized, the day in numerals with no "th"`,
        value !== undefined && value >= 1 && value <= 31
          ? [capitalized(month), String(value)]
          : undefined,
      ),
    );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => DateForm[] = wordRule(code, find);

/** Writes the date as "March 19". */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly DateForm[],
) {
  return rewrite(meeting, violations);
}
