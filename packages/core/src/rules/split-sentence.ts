import { formatClock } from "../clock";
import { splitSentences } from "../transcription";
import type { InSegment, RuleMeeting, Severity, Violation } from "./common";

export const code = "split-sentence";

export type SplitSentence = Violation<typeof code> &
  InSegment & {
    /** Onset of the segment's first word. */
    atSecs: number;
    /** Onset of the word after the longer pause, where the turn probably changes. */
    edgeStartSecs: number;
    /** The words between the two, which probably belong to the other speaker. */
    misplaced: string[];
  };

export const defaultSeverity = "warning" satisfies Severity;

/**
 * A speaker change inside a sentence, a few words from a clearly longer
 * pause (see transcription/turn-edges.ts).
 */
export function rule(meeting: RuleMeeting): SplitSentence[] {
  const { segments } = meeting;
  return splitSentences(segments)
    .filter(
      (split) =>
        segments[split.segment - 1]!.speaker !==
        segments[split.segment]!.speaker,
    )
    .map((split) => {
      const misplaced = split.misplaced.map((w) => w.text);
      return {
        code,
        message: `speaker change at ${formatClock(split.start)} splits a sentence; the pause at ${formatClock(split.edgeStart)} is longer (${split.edgePause}s vs ${split.pause}s), so ${JSON.stringify(misplaced.join(" "))} may belong to the other speaker. Move the boundary to the sentence edge where the voice changes`,
        segmentIndex: split.segment,
        atSecs: split.start,
        edgeStartSecs: split.edgeStart,
        misplaced,
      };
    });
}
