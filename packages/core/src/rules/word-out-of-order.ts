import { formatClock } from "../clock";
import type { AtWord, RuleMeeting, Severity, Violation } from "./common";

export type WordOutOfOrder = Violation<"word-out-of-order"> &
  AtWord & {
    /** Onset of the word before it. */
    previousStartSecs: number;
  };

export const defaultSeverity = "error" satisfies Severity;

/** A word that starts before the word before it in its segment. */
export function rule(meeting: RuleMeeting): WordOutOfOrder[] {
  return meeting.segments.flatMap(({ words }, segment) =>
    words.flatMap((w, word) => {
      const prev = words[word - 1];
      if (!prev || w.start >= prev.start) return [];
      return [
        {
          code: "word-out-of-order" as const,
          message: `word onset ${formatClock(w.start)} is before the previous word's (${formatClock(prev.start)}); words must be in time order`,
          segmentIndex: segment,
          wordIndex: word,
          atSecs: w.start,
          previousStartSecs: prev.start,
        },
      ];
    }),
  );
}
