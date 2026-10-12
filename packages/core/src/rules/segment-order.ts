import { formatClock } from "../clock";
import type { AtWord, RuleMeeting, Violation } from "./common";

export type SegmentOrder = Violation<"segment-order"> &
  AtWord & {
    /** Onset of the latest word in the segments before it. */
    previousLastWord: number;
  };

/** A segment that starts before an earlier one's last word. */
export function segmentOrder(meeting: RuleMeeting): SegmentOrder[] {
  const results: SegmentOrder[] = [];
  let prevLast = -Infinity;
  meeting.segments.forEach(({ words }, segment) => {
    if (words.length === 0) return;
    const at = words[0]!.start;
    if (at < prevLast)
      results.push({
        code: "segment-order",
        message: `starts at ${formatClock(at)}, before the previous segment's last word (${formatClock(prevLast)}); segments must not interleave`,
        segment,
        word: 0,
        at,
        previousLastWord: prevLast,
      });
    prevLast = Math.max(prevLast, ...words.map((w) => w.start));
  });
  return results;
}
