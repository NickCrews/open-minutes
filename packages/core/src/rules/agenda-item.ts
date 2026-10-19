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

export const code = "agenda-item";

export type AgendaItem = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/** "10", "B", "1" as "10.B.1". */
function dotted(number: string, letter: string, sub: string): string {
  return [number, letter, sub].filter(Boolean).join(".");
}

const ITEM = /^(\d{1,2})([A-H])(\d{0,2})$/;

/**
 * Anchorage Assembly agenda items: "10.B.1", "14.C", not "10 B1", "10A1" or
 * "14B".
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const c = core(w);
    const item = ITEM.exec(c);
    if (item) {
      found.push(
        finding(
          i,
          words,
          1,
          `write an agenda item with dots, as "10.B.1" or "14.C"`,
          [dotted(item[1]!, item[2]!, item[3]!)],
        ),
      );
      return;
    }
    const next = words[i + 1];
    const rest = /^([A-H])(\d{0,2})$/.exec(core(next ?? ""));
    if (/^\d{1,2}$/.test(c) && !endsPhrase(w) && rest)
      found.push(
        finding(
          i,
          words,
          2,
          `write an agenda item with dots, as "10.B.1" or "14.C"`,
          [dotted(c, rest[1]!, rest[2]!)],
        ),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => AgendaItem[] = wordRule(
  code,
  find,
);

/** Writes the item with dots: "10 B1" as "10.B.1". */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly AgendaItem[],
) {
  return rewrite(meeting, violations);
}
