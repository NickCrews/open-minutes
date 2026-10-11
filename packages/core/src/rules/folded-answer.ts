import { foldedAnswers } from "../transcription";
import type { AtWord, RuleMeeting, Severity, Violation } from "./common";

export const code = "folded-answer";

export type FoldedAnswer = Violation<typeof code> &
  AtWord & {
    /** The answer, eg "Yes." */
    answer: string;
    /** The sentence that asked for it, or that restates the motion after it. */
    asked: string;
  };

export const defaultSeverity = "warning" satisfies Severity;

/**
 * A one-word answer ("Yes.", "Second.") in the same segment as the question,
 * roll call or call for a motion it answers (see transcription/folded-answers.ts).
 */
export function rule(meeting: RuleMeeting): FoldedAnswer[] {
  return meeting.segments.flatMap(({ words }, segment) =>
    foldedAnswers(words).map((f) => ({
      code,
      message: `${JSON.stringify(f.answer)} and ${JSON.stringify(f.asked)} are in one segment; the answer is probably someone else's. Give it its own segment under whoever was asked, or whoever the motion names`,
      segmentIndex: segment,
      wordIndex: f.index,
      atSecs: words[f.index]!.start,
      answer: f.answer,
      asked: f.asked,
    })),
  );
}
