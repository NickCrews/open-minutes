import { uncoveredSpeech as uncoveredSpans } from "../chapters";
import { formatClock } from "../clock";
import {
  type RuleMeeting,
  type Severity,
  speechSpans,
  type Violation,
} from "./common";

export type UncoveredSpeech = Violation<"uncovered-speech"> & {
  /** Where the uncovered speech starts. */
  atSecs: number;
  endSecs: number;
};

export const defaultSeverity = "warning" satisfies Severity;

/** A long stretch of speech in no chapter, when the meeting has chapters. */
export function rule(meeting: RuleMeeting): UncoveredSpeech[] {
  if (!meeting.chapters?.length) return [];
  return uncoveredSpans(speechSpans(meeting), meeting.chapters).map((gap) => ({
    code: "uncovered-speech",
    message: `speech from ${formatClock(gap.start)} to ${formatClock(gap.end)} is in no chapter; extend a neighbouring chapter or add one`,
    atSecs: gap.start,
    endSecs: gap.end,
  }));
}
