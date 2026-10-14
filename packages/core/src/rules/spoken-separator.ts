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

export const code = "spoken-separator";

export type SpokenSeparator = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * A number with "dot", "dash", "slash" or "point" spoken in it: "3.70.190",
 * "2026-23", "4.3", not "three dot seventy", "six dash two" or "four point
 * three".
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const lower = core(w).toLowerCase();
    if (
      ["dot", "dots", "dash", "slash", "point"].includes(lower) &&
      !endsPhrase(w) &&
      i > 0 &&
      isNumber(words[i - 1]!) &&
      !endsPhrase(words[i - 1]!) &&
      i + 1 < words.length &&
      isNumber(words[i + 1]!)
    )
      found.push(
        finding(
          i - 1,
          words,
          3,
          `write a number with "${lower}" in it in digits, eg "3.70.190", "2026-23", "4.3"`,
        ),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => SpokenSeparator[] = wordRule(
  code,
  find,
);
