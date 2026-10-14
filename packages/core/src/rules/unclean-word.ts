import { cleanWords } from "../transcription";
import type { AtWord, Fix, RuleMeeting, Severity, Violation } from "./common";

export const code = "unclean-word";

export type UncleanWord = Violation<typeof code> &
  AtWord & {
    /** The cleaning rule that would remove it, eg "filler". */
    rule: string;
    text: string;
  };

export const defaultSeverity = "error" satisfies Severity;

/**
 * A disfluency the pipeline's clean stage would have removed ("um", "the
 * the"; see transcription/clean.ts).
 */
export function rule(meeting: RuleMeeting): UncleanWord[] {
  return meeting.segments.flatMap(({ words }, segment) =>
    cleanWords(words)
      // A word recased, not removed, is a knock-on fix, eg a passed-on capital.
      .changes.filter((c) => c.after === null)
      .map((c) => ({
        code,
        message: `${c.rule} ${JSON.stringify(c.before)} should not be in a transcript`,
        segmentIndex: segment,
        // By onset alone: a rule may report a word after an earlier rule recased it.
        wordIndex: words.findIndex((w) => w.start === c.start),
        atSecs: c.start,
        rule: c.rule,
        text: c.before,
      })),
  );
}

/** Cleans each segment's words, as the pipeline's clean stage does. */
export const fix: Fix = (meeting) => {
  let changed = false;
  const segments = meeting.segments.map((seg) => {
    const { words, changes } = cleanWords(seg.words);
    if (changes.length === 0) return seg;
    changed = true;
    return { ...seg, words };
  });
  return changed ? { ...meeting, segments } : meeting;
};
