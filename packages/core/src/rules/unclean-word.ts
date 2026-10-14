import { cleanWords } from "../transcription";
import type { AtWord, RuleMeeting, Violation } from "./common";

export type UncleanWord = Violation<"unclean-word"> &
  AtWord & {
    /** The cleaning rule that would remove it, eg "filler". */
    rule: string;
    text: string;
  };

/**
 * A disfluency the pipeline's clean stage would have removed ("um", "the
 * the"; see transcription/clean.ts).
 */
export function uncleanWord(meeting: RuleMeeting): UncleanWord[] {
  return meeting.segments.flatMap(({ words }, segment) =>
    cleanWords(words)
      // A word recased, not removed, is a knock-on fix, eg a passed-on capital.
      .changes.filter((c) => c.after === null)
      .map((c) => ({
        code: "unclean-word" as const,
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
