import type { RuleMeeting, Severity } from "./common";
import {
  amount,
  amountStart,
  amountValue,
  core,
  endsAmount,
  type Finding,
  finding,
  isNumberWord,
  numeral,
  rewrite,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "money";

export type Money = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * Money: "$10", "$36,000", "$1.5 million", not "ten dollars" or "5,000
 * dollar". Reported from the amount's first word: "thirty six thousand
 * dollars".
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const c = core(w).toLowerCase();
    if (/^dollars?$/.test(c) && endsAmount(words, i - 1)) {
      const start = amountStart(words, i - 1);
      const value = amountValue(words.slice(start, i));
      const written = value === undefined ? undefined : amount(value);
      found.push(
        finding(
          start,
          words,
          i + 1 - start,
          `write a sum of money as "$10", "$36,000" or "$1.5 million"`,
          written && [`$${written[0]}`, ...written.slice(1)],
        ),
      );
    } else if (/^cents?$/.test(c) && i > 0 && isNumberWord(words[i - 1]!)) {
      const start = amountStart(words, i - 1);
      const value = amountValue(words.slice(start, i));
      found.push(
        finding(
          start,
          words,
          i + 1 - start,
          `write cents in numerals, as "6 cents"`,
          value === undefined ? undefined : [numeral(value), c],
        ),
      );
    }
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => Money[] = wordRule(code, find);

/** Writes the sum as "$10" or "$1.5 million", and cents as "6 cents". */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly Money[],
) {
  return rewrite(meeting, violations);
}
