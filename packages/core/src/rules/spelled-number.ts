import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsPhrase,
  endsSentence,
  type Finding,
  isNumberWord,
  isOrdinalWord,
  MULTIPLIERS,
  TENS,
  wordRule,
  wordValue,
  type WrittenForm,
} from "./numbers";

export const code = "spelled-number";

export type SpelledNumber = WrittenForm<typeof code>;

export const defaultSeverity = "warning" satisfies Severity;

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
    if (flagged && !sentenceStart)
      found.push({
        index: i,
        text: run.join(" "),
        message: single
          ? `write a number of 10 or more in numerals ("11", "36", "14th")`
          : `write a spoken number in numerals ("2026", "155", "5-0", "907-243-VOTE")`,
      });
    i = j;
  }
  return found;
}

export const rule: (meeting: RuleMeeting) => SpelledNumber[] = wordRule(
  code,
  find,
);
