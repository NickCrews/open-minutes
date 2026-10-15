import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsPhrase,
  type Finding,
  finding,
  rewrite,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "bill-number";

export type BillNumber = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * How to write the number after a bill's prefix, from it (`n`, without
 * trailing punctuation) and the word after it, and how many of the two it
 * takes; undefined when the words don't say. "2026 48" is 2026-48, "26-36"
 * 2026-36, "2025-144S" 2025-144(S), and an assembly memorandum's "142 2026"
 * 142-2026.
 */
function billNumber(
  prefix: string,
  n: string,
  next: string,
  after: string | undefined,
): { number: string; takes: number } | undefined {
  const following = core(after ?? "");
  if (prefix === "AM" || prefix === "AIM") {
    if (n === next && /^\d{1,4}$/.test(n) && /^\d{4}$/.test(following))
      return { number: `${n}-${following}`, takes: 2 };
    return undefined;
  }
  if (n === next && /^\d{4}$/.test(n) && /^\d{1,4}$/.test(following))
    return { number: `${n}-${following}`, takes: 2 };
  const short = /^(\d{2})-(\d{1,4})$/.exec(n);
  if (short) return { number: `20${short[1]}-${short[2]}`, takes: 1 };
  const substitute = /^(\d{4}-\d{1,4})(S(-\d+)?)$/.exec(n);
  if (substitute)
    return { number: `${substitute[1]}(${substitute[2]})`, takes: 1 };
  return undefined;
}

/**
 * Anchorage bills: "AO 2026-20", "AR 2026-7", "AO 2025-144(S)", "AM 142-2026".
 * Catches the recognizer's "AR 2026 48", "AO2026-23", "A02026-27",
 * "AO 2025-144S" and "AR 26-36".
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const c = core(w);
    const joined = /^(AO|AR|AIM|AM|A0)(\d.*)$/.exec(c);
    if (joined) {
      found.push(
        finding(
          i,
          words,
          1,
          `write a bill as "AO 2026-23": a space after the prefix, and the letter O, not zero`,
          [joined[1]!.replace("0", "O"), joined[2]!],
        ),
      );
      return;
    }
    if (!/^(AO|AR|AIM|AM)$/.test(c) || endsPhrase(w)) return;
    const next = words[i + 1];
    if (next === undefined) return;
    const n = next.replace(/[.,;:?!]+$/, "");
    if (!/^\d/.test(n)) return;
    const ok =
      c === "AM" || c === "AIM"
        ? /^\d{1,4}-\d{4}$/.test(n)
        : /^\d{4}-\d{1,4}(\(S(-\d+)?\))?$/.test(n) ||
          (/^\d{4}$/.test(n) &&
            !endsPhrase(next) &&
            core(words[i + 2] ?? "").toLowerCase() === "unnumbered");
    if (ok) return;
    const fixed = billNumber(c, n, next, words[i + 2]);
    found.push(
      finding(
        i,
        words,
        1 + (fixed?.takes ?? 1),
        c === "AM" || c === "AIM"
          ? `write an assembly memorandum as "${c} 142-2026"`
          : `write a bill as "${c} 2026-23", a substitute as "${c} 2025-144(S)" or "(S-2)", and one not yet numbered as "${c} 2026 unnumbered"`,
        fixed && [c, fixed.number],
      ),
    );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => BillNumber[] = wordRule(
  code,
  find,
);

/** Writes the bill as "AO 2026-23", when the words say its number. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly BillNumber[],
) {
  return rewrite(meeting, violations);
}
