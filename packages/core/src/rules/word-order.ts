import { formatClock } from "../clock";
import type { AtWord, RuleMeeting, Violation } from "./common";

export type WordOrder = Violation<"word-order"> &
  AtWord & {
    /** Onset of the word before it. */
    previousStart: number;
  };

/** A word that starts before the word before it in its segment. */
export function wordOrder(meeting: RuleMeeting): WordOrder[] {
  return meeting.segments.flatMap(({ words }, segment) =>
    words.flatMap((w, word) => {
      const prev = words[word - 1];
      if (!prev || w.start >= prev.start) return [];
      return [
        {
          code: "word-order" as const,
          message: `word onset ${formatClock(w.start)} is before the previous word's (${formatClock(prev.start)}); words must be in time order`,
          segment,
          word,
          at: w.start,
          previousStart: prev.start,
        },
      ];
    }),
  );
}
