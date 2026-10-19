import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsSentence,
  type Finding,
  finding,
  isNumberWord,
  isOrdinalWord,
  rewrite,
  wordRule,
  wordValue,
  type WrittenForm,
} from "./numbers";

export const code = "tally";

export type Tally = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/** A count of votes from one number word: "five" is 5, "fifth" nothing. */
function votes(text: string): number | undefined {
  const v = wordValue(text);
  return v !== undefined && v < 100 && !isOrdinalWord(text) ? v : undefined;
}

/**
 * Vote tallies: "passes 5-0", "fails 3-2", not "passes five zero", "passes
 * three, two" or "fails four to one". (A vote said with "to", "on a vote of
 * 12 to 0", is written that way.)
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    if (!/^(passes|passed|fails|failed|carries|carried)$/i.test(core(w)))
      return;
    const [a, b, c] = [words[i + 1], words[i + 2], words[i + 3]];
    if (a === undefined || !isNumberWord(a)) return;
    const withTo =
      b !== undefined &&
      core(b).toLowerCase() === "to" &&
      c !== undefined &&
      isNumberWord(c);
    if (!withTo && !(b !== undefined && isNumberWord(b) && !endsSentence(a)))
      return;
    const [yes, no] = [votes(a), votes(withTo ? c! : b!)];
    found.push(
      finding(
        i + 1,
        words,
        withTo ? 3 : 2,
        `write a tally as "5-0" or "3-2"`,
        yes === undefined || no === undefined ? undefined : [`${yes}-${no}`],
      ),
    );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => Tally[] = wordRule(code, find);

/** Writes the tally as "5-0". */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly Tally[],
) {
  return rewrite(meeting, violations);
}
