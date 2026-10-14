import { formatClock } from "../clock";
import type { AtWord, RuleMeeting, Violation } from "./common";

export type SegmentOutOfOrder = Violation<"segment-out-of-order"> &
  AtWord & {
    /** Onset of the latest word in the segments before it. */
    previousLastWordSecs: number;
  };

/** A segment that starts before an earlier one's last word. */
export function segmentOutOfOrder(meeting: RuleMeeting): SegmentOutOfOrder[] {
  const results: SegmentOutOfOrder[] = [];
  let prevLast = -Infinity;
  meeting.segments.forEach(({ words }, segment) => {
    if (words.length === 0) return;
    const at = words[0]!.start;
    if (at < prevLast)
      results.push({
        code: "segment-out-of-order",
        message: `starts at ${formatClock(at)}, before the previous segment's last word (${formatClock(prevLast)}); segments must not interleave`,
        segmentIndex: segment,
        wordIndex: 0,
        atSecs: at,
        previousLastWordSecs: prevLast,
      });
    prevLast = Math.max(prevLast, ...words.map((w) => w.start));
  });
  return results;
}
