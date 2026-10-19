import type { RuleMeeting, Severity } from "./common";
import {
  amount,
  cardinal,
  core,
  endsPhrase,
  endsSentence,
  type Finding,
  isNumberWord,
  isOrdinalWord,
  MULTIPLIERS,
  ordinalSuffix,
  rewrite,
  TENS,
  wordRule,
  wordValue,
  type WrittenForm,
  year,
} from "./numbers";

export const code = "spelled-number";

export type SpelledNumber = WrittenForm<typeof code>;

export const defaultSeverity = "warning" satisfies Severity;

/**
 * A run of number words in numerals, when it has one reading: "eleven" is
 * "11", "thirty six thousand" "36,000", "five million" "5 million", "twenty
 * fourth" "24th", "twenty twenty six" "2026". Not "five zero" (50, or a
 * tally?), "one fifty five" (155, or 1:55?), or a number from 1,000 to 9,999
 * said with "thousand" that isn't a round hundred ("two thousand twenty
 * six": a year, or a count?).
 */
function written(run: readonly string[]): string[] | undefined {
  const read = cardinal(run);
  if (read) {
    const { value, ordinal } = read;
    if (ordinal) return [`${value}${ordinalSuffix(value)}`];
    if (value >= 1000 && value < 10000 && value % 100 !== 0) return undefined;
    return amount(value);
  }
  const y = year(run);
  return y === undefined ? undefined : [String(y)];
}

/**
 * Number words the style writes as numerals: any run of two or more ("twenty
 * twenty six", "five zero", "one fifty five"), or one word worth 10 or more
 * ("eleven", "thirty-six", "fourteenth"). Not at the start of a sentence,
 * and not "hundred", "thousand" or "million" on their own ("a few hundred",
 * "a million reasons"). "oh" counts only between number words.
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  const numeric = (i: number): boolean => {
    const t = words[i];
    if (t === undefined) return false;
    const c = core(t).toLowerCase();
    if (c === "oh")
      return (
        i > 0 &&
        isNumberWord(words[i - 1]!) &&
        !endsPhrase(words[i - 1]!) &&
        isNumberWord(words[i + 1] ?? "")
      );
    return isNumberWord(t);
  };
  let i = 0;
  while (i < words.length) {
    if (!numeric(i)) {
      i++;
      continue;
    }
    let j = i + 1;
    // An ordinal ends a run, and only a tens word runs into one: "twenty
    // fourth", but "one second", "one third", "the first three".
    while (
      j < words.length &&
      numeric(j) &&
      !endsPhrase(words[j - 1]!) &&
      !isOrdinalWord(words[j - 1]!) &&
      !(
        isOrdinalWord(words[j]!) && !(core(words[j - 1]!).toLowerCase() in TENS)
      )
    )
      j++;
    const run = words.slice(i, j);
    const sentenceStart = i === 0 || endsSentence(words[i - 1]!);
    const single = run.length === 1;
    const value = wordValue(run[0]!)!;
    const c = core(run[0]!).toLowerCase();
    const flagged =
      !single || (value >= 10 && !(c in MULTIPLIERS) && c !== "hundredth");
    const replacement = written(run);
    if (flagged && !sentenceStart)
      found.push({
        index: i,
        text: run.join(" "),
        message: single
          ? `write a number of 10 or more in numerals ("11", "36", "14th")`
          : `write a spoken number in numerals ("2026", "155", "5-0", "907-243-VOTE")`,
        ...(replacement && { replacement }),
      });
    i = j;
  }
  return found;
}

export const rule: (meeting: RuleMeeting) => SpelledNumber[] = wordRule(
  code,
  find,
);

/** Writes the number in numerals, when its words have one reading. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly SpelledNumber[],
) {
  return rewrite(meeting, violations);
}
