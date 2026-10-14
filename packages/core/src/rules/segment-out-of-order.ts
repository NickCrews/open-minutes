import { formatClock } from "../clock";
import type { AtWord, RuleMeeting, Severity, Violation } from "./common";

export const code = "segment-out-of-order";

export type SegmentOutOfOrder = Violation<typeof code> &
  AtWord & {
    /** Onset of the latest word in the segments before it. */
    previousLastWordSecs: number;
  };

export const defaultSeverity = "error" satisfies Severity;

/** A segment that starts before an earlier one's last word. */
export function rule(meeting: RuleMeeting): SegmentOutOfOrder[] {
  const results: SegmentOutOfOrder[] = [];
  let prevLast = -Infinity;
  meeting.segments.forEach(({ words }, segment) => {
    if (words.length === 0) return;
    const at = words[0]!.start;
    if (at < prevLast)
      results.push({
        code,
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
