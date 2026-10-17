import type { RuleMeeting, Severity } from "./common";
import {
  core,
  type Finding,
  rewrite,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "split-numeral";

export type SplitNumeral = WrittenForm<typeof code>;

export const defaultSeverity = "warning" satisfies Severity;

/**
 * The one number two numerals make, when the words say which: thousands
 * ("100 000" is 100,000, since no count is written "000"), and a time before
 * "a.m." or "p.m." ("11 15 AM" is 11:15).
 */
function joined(
  first: string,
  second: string,
  after: string | undefined,
): string | undefined {
  const s = second.replace(/[.,;:?!]$/, "");
  if (/^\d{1,3}(,\d{3})*$/.test(first) && /^0\d\d$/.test(s))
    return `${first},${s}`;
  if (
    /^(a\.?m|p\.?m)$/i.test(core(after ?? "")) &&
    /^([1-9]|1[0-2])$/.test(first) &&
    /^[0-5]\d$/.test(s)
  )
    return `${first}:${s}`;
  return undefined;
}

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
    ) {
      const replacement = joined(t, next, words[i + 2]);
      found.push({
        index: i,
        text: `${t} ${next}`,
        message: `two numerals in a row are usually one number: "2026-48", "11:15", "100,000"`,
        ...(replacement && { replacement: [replacement] }),
      });
    }
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => SplitNumeral[] = wordRule(
  code,
  find,
);

/** Joins the numerals into the one number they say, when the words say which. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly SplitNumeral[],
) {
  return rewrite(meeting, violations);
}
