import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsPhrase,
  type Finding,
  finding,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "agenda-item";

export type AgendaItem = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * Anchorage Assembly agenda items: "10.B.1", "14.C", not "10 B1", "10A1" or
 * "14B".
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const c = core(w);
    if (/^\d{1,2}[A-H]\d{0,2}$/.test(c)) {
      found.push(
        finding(
          i,
          words,
          1,
          `write an agenda item with dots, as "10.B.1" or "14.C"`,
        ),
      );
      return;
    }
    const next = words[i + 1];
    if (
      /^\d{1,2}$/.test(c) &&
      !endsPhrase(w) &&
      next !== undefined &&
      /^[A-H]\d{0,2}$/.test(core(next))
    )
      found.push(
        finding(
          i,
          words,
          2,
          `write an agenda item with dots, as "10.B.1" or "14.C"`,
        ),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => AgendaItem[] = wordRule(
  code,
  find,
);
