import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsPhrase,
  type Finding,
  finding,
  rewrite,
  wordRule,
  wordValue,
  type WrittenForm,
} from "./numbers";

export const code = "zoning-district";

export type ZoningDistrict = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

// Districts are numbered 1 to 10; "R19" is something else, like a permit.
// Girdwood's districts (AMC 21.09) start with a lowercase g: "gR-1", "gC-8".
const ZONING =
  /^(R|B|I|CER|CEB|CE-R|CE-B|GR|GC|GT|GI|gR|gC|gT|gI)-?(([1-9]|10)[A-Z]?)$/;

/** How a district is written: "R-4", "CE-R-10", "gR-1". */
function zoningDistrict(prefix: string, number: string): string {
  const p = /^g/i.test(prefix)
    ? `g${prefix[1]}`
    : prefix.replace(/^CE-?/, "CE-");
  return `${p}-${number}`;
}

/**
 * Anchorage zoning districts (AMC title 21): "R-4", "R-2M", "B-3",
 * Chugiak-Eagle River's "CE-R-10", and Girdwood's "gR-1", "gC-8".
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const c = core(w);
    // "CER three", "GC 8": a district said as two words. Not "R 10" or
    // "B one", which can be list items.
    const next = words[i + 1];
    if (
      /^(CER|CEB|GR|GC|gR|gC)$/.test(c) &&
      !endsPhrase(w) &&
      next !== undefined &&
      (/^\d{1,2}$/.test(core(next)) ||
        ((wordValue(next) ?? 0) >= 1 && (wordValue(next) ?? 0) <= 10))
    ) {
      const n = /^\d/.test(core(next)) ? core(next) : wordValue(next)!;
      const want = zoningDistrict(c, String(n));
      found.push(
        finding(i, words, 2, `write the zoning district as "${want}"`, [want]),
      );
      return;
    }
    const m = ZONING.exec(c);
    // "10 B1" is an agenda item, found by the agenda-item rule.
    if (!m || /^\d{1,2}$/.test(words[i - 1] ?? "")) return;
    const want = zoningDistrict(m[1]!, m[2]!);
    if (c !== want)
      found.push(
        finding(i, words, 1, `write the zoning district as "${want}"`, [want]),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => ZoningDistrict[] = wordRule(
  code,
  find,
);

/** Writes the district as "R-4", "CE-R-10" or "gR-1". */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly ZoningDistrict[],
) {
  return rewrite(meeting, violations);
}
