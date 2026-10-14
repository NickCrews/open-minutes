import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsAmount,
  type Finding,
  finding,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "percent";

export type Percent = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/** Percentages: "1%", "3.79%", "100%", not "one percent". */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    if (/^percent$/i.test(core(w)) && endsAmount(words, i - 1))
      found.push(
        finding(i - 1, words, 2, `write a percentage as "1%" or "3.79%"`),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => Percent[] = wordRule(code, find);
