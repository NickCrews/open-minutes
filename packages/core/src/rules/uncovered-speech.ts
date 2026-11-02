import { formatClock } from "../clock";
import { mergeSpans, type Span, subtract } from "../span";
import {
  type RuleMeeting,
  type Severity,
  speechSpans,
  type Violation,
} from "./common";

export const code = "uncovered-speech";

export type UncoveredSpeech = Violation<typeof code> & {
  /** Where the uncovered speech starts. */
  atSecs: number;
  endSecs: number;
};

export const defaultSeverity = "warning" satisfies Severity;

/**
 * Uncovered speech longer than this is a candidate missed topic. Anything
 * shorter is boundary slop between neighbouring chapters.
 */
export const MAX_UNCOVERED_SPEECH_SECS = 30;

/** A long stretch of speech in no chapter, when the meeting has chapters. */
export function rule(meeting: RuleMeeting): UncoveredSpeech[] {
  if (!meeting.chapters?.length) return [];
  return uncoveredSpans(speechSpans(meeting), meeting.chapters).map((gap) => ({
    code,
    message: `speech from ${formatClock(gap.start)} to ${formatClock(gap.end)} is in no chapter; extend a neighbouring chapter or add one`,
    atSecs: gap.start,
    endSecs: gap.end,
  }));
}

/**
 * Stretches of speech that no chapter covers, merged and longer than
 * {@link MAX_UNCOVERED_SPEECH_SECS}. `speech` and `chapters` needn't be sorted.
 */
export function uncoveredSpans(
  speech: readonly Span[],
  chapters: readonly Span[],
): Span[] {
  const byStart = (a: Span, b: Span) => a.start - b.start;
  const uncovered = subtract(
    [...speech].sort(byStart),
    [...chapters].sort(byStart),
  );
  // Merge pieces that touch, so a gap spanning several segments counts once.
  return mergeSpans(uncovered, 0).filter(
    (u) => u.end - u.start > MAX_UNCOVERED_SPEECH_SECS,
  );
}
