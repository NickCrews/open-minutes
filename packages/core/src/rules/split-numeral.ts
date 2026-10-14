import type { RuleMeeting, Severity } from "./common";
import { type Finding, wordRule, type WrittenForm } from "./numbers";

export const code = "split-numeral";

export type SplitNumeral = WrittenForm<typeof code>;

export const defaultSeverity = "warning" satisfies Severity;

/**
 * Numerals said as two numbers but meant as one: "2026 48" (AR 2026-48),
 * "11 15" (11:15), "100 000" (100,000). Two numerals in a row with nothing
 * between them; a year then a count ("in 2024 30 people") is the exception
 * to look out for.
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((t, i) => {
    const next = words[i + 1];
    if (
      next !== undefined &&
      /^\d([\d,.]*\d)?$/.test(t) &&
      /^\d[\d,.]*[.,;:?!]?$/.test(next)
    )
      found.push({
        index: i,
        text: `${t} ${next}`,
        message: `two numerals in a row are usually one number: "2026-48", "11:15", "100,000"`,
      });
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => SplitNumeral[] = wordRule(
  code,
  find,
);
