import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsPhrase,
  type Finding,
  finding,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "bill-number";

export type BillNumber = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * Anchorage bills: "AO 2026-20", "AR 2026-7", "AO 2025-144(S)", "AM 142-2026".
 * Catches the recognizer's "AR 2026 48", "AO2026-23", "A02026-27",
 * "AO 2025-144S" and "AR 26-36".
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const c = core(w);
    if (/^(AO|AR|AM|AIM|A0)\d/.test(c)) {
      found.push(
        finding(
          i,
          words,
          1,
          `write a bill as "AO 2026-23": a space after the prefix, and the letter O, not zero`,
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
    if (!ok)
      found.push(
        finding(
          i,
          words,
          2,
          c === "AM" || c === "AIM"
            ? `write an assembly memorandum as "${c} 142-2026"`
            : `write a bill as "${c} 2026-23", a substitute as "${c} 2025-144(S)" or "(S-2)", and one not yet numbered as "${c} 2026 unnumbered"`,
        ),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => BillNumber[] = wordRule(
  code,
  find,
);
