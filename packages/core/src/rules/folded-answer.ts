import { foldedAnswers } from "../transcription";
import type { AtWord, Fixed, RuleMeeting, Severity, Violation } from "./common";

export const code = "folded-answer";

export type FoldedAnswer = Violation<typeof code> &
  AtWord & {
    /** The answer, eg "Yes." */
    answer: string;
    /** The sentence that asked for it, or that restates the motion after it. */
    asked: string;
    /** What it answers (see transcription/folded-answers.ts). */
    answers: "motion" | "roll-call" | "vote" | "question";
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
      answers: f.answers,
    })),
  );
}

/**
 * Moves each answer to a motion, roll call or vote into a segment of its
 * own, with no speaker: someone else said it, but the words don't say who.
 * An answer to another question stays, since the asker may have answered it.
 */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly FoldedAnswer[],
): Fixed<M, FoldedAnswer> {
  const bySegment = new Map<number, FoldedAnswer[]>();
  for (const v of violations)
    if (v.answers !== "question")
      bySegment.set(v.segmentIndex, [
        ...(bySegment.get(v.segmentIndex) ?? []),
        v,
      ]);
  if (bySegment.size === 0) return { meeting, fixed: [] };
  const fixed: FoldedAnswer[] = [];
  const segments = meeting.segments.flatMap((seg, segmentIndex) => {
    const found = bySegment.get(segmentIndex);
    if (!found) return [seg];
    const pieces: (typeof seg)[] = [];
    let from = 0;
    for (const v of [...found].sort((a, b) => a.wordIndex - b.wordIndex)) {
      if (v.wordIndex < from) continue;
      const to = v.wordIndex + v.answer.split(" ").length;
      if (v.wordIndex > from)
        pieces.push({ ...seg, words: seg.words.slice(from, v.wordIndex) });
      pieces.push({
        ...seg,
        speaker: null,
        words: seg.words.slice(v.wordIndex, to),
      });
      from = to;
      fixed.push(v);
    }
    if (from < seg.words.length)
      pieces.push({ ...seg, words: seg.words.slice(from) });
    return pieces;
  });
  return { meeting: { ...meeting, segments }, fixed };
}
