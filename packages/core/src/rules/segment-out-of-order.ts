import { formatClock } from "../clock";
import type { AtWord, Fixed, RuleMeeting, Severity, Violation } from "./common";

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

/**
 * Puts segments in order of their first word, leaving any without words where
 * they are. Segments that interleave stay out of order: which words belong to
 * which takes judgment.
 */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly SegmentOutOfOrder[],
): Fixed<M, SegmentOutOfOrder> {
  const { segments } = meeting;
  const sorted = segments
    .filter((seg) => seg.words.length > 0)
    .sort((a, b) => a.words[0]!.start - b.words[0]!.start);
  let next = 0;
  const reordered = segments.map((seg) =>
    seg.words.length > 0 ? sorted[next++]! : seg,
  );
  if (reordered.every((seg, i) => seg === segments[i]))
    return { meeting, fixed: [] };
  const fixedMeeting = { ...meeting, segments: reordered };
  const stillOut = new Set(
    rule(fixedMeeting).map((v) => reordered[v.segmentIndex]),
  );
  return {
    meeting: fixedMeeting,
    fixed: violations.filter((v) => !stillOut.has(segments[v.segmentIndex]!)),
  };
}
