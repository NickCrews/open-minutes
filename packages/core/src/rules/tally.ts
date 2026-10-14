import type { RuleMeeting, Severity } from "./common";
import {
  core,
  endsSentence,
  type Finding,
  finding,
  isNumberWord,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "tally";

export type Tally = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

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
    if (
      (b !== undefined && isNumberWord(b) && !endsSentence(a)) ||
      (b !== undefined &&
        core(b).toLowerCase() === "to" &&
        c !== undefined &&
        isNumberWord(c))
    )
      found.push(
        finding(
          i + 1,
          words,
          core(b ?? "") === "to" ? 3 : 2,
          `write a tally as "5-0" or "3-2"`,
        ),
      );
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => Tally[] = wordRule(code, find);
