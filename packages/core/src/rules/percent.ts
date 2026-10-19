import type { RuleMeeting, Severity } from "./common";
import {
  amountStart,
  amountValue,
  core,
  endsAmount,
  type Finding,
  finding,
  numeral,
  rewrite,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "percent";

export type Percent = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * Percentages: "1%", "3.79%", "100%", not "one percent". Reported from the
 * amount's first word: "one hundred percent".
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    if (!/^percent$/i.test(core(w)) || !endsAmount(words, i - 1)) return;
    const start = amountStart(words, i - 1);
    const value = amountValue(words.slice(start, i));
    found.push(
      finding(
        start,
        words,
        i + 1 - start,
        `write a percentage as "1%" or "3.79%"`,
        value === undefined ? undefined : [`${numeral(value)}%`],
      ),
    );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => Percent[] = wordRule(code, find);

/** Writes the percentage as "1%" or "3.79%". */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly Percent[],
) {
  return rewrite(meeting, violations);
}
