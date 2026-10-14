import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsAmount,
  type Finding,
  finding,
  isNumberWord,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "money";

export type Money = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/** Money: "$10", "$36,000", "$1.5 million", not "ten dollars" or "5,000 dollar". */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const c = core(w).toLowerCase();
    if (/^dollars?$/.test(c) && endsAmount(words, i - 1))
      found.push(
        finding(
          i - 1,
          words,
          2,
          `write a sum of money as "$10", "$36,000" or "$1.5 million"`,
        ),
      );
    else if (/^cents?$/.test(c) && i > 0 && isNumberWord(words[i - 1]!))
      found.push(
        finding(i - 1, words, 2, `write cents in numerals, as "6 cents"`),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => Money[] = wordRule(code, find);
