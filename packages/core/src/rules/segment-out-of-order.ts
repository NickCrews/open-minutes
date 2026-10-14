import { formatClock } from "../clock";
import type { AtWord, Fixed, RuleMeeting, Severity, Violation } from "./common";

export const code = "segment-out-of-order";

/**
 * An earlier segment whose words mix with a later one's, between `fromSecs`
 * (the later of the two first words) and `toSecs` (the earlier of the two
 * last words).
 */
export interface Interleaving {
  segmentIndex: number;
  fromSecs: number;
  toSecs: number;
}

export type SegmentOutOfOrder = Violation<typeof code> &
  AtWord & {
    /** Onset of the latest word in the segments before it. */
    previousLastWordSecs: number;
    /**
     * The earlier segments whose words mix with this one's. Empty when
     * putting the segments in order of their first word fixes it.
     */
    interleaves: Interleaving[];
  };

export const defaultSeverity = "error" satisfies Severity;

/** Where a segment's words fall: its first word's onset and its latest. */
interface Span {
  segmentIndex: number;
  first: number;
  last: number;
}

function describe(at: number, prevLast: number, interleaves: Interleaving[]) {
  const starts = `starts at ${formatClock(at)}, before the previous segment's last word (${formatClock(prevLast)})`;
  if (interleaves.length === 0)
    return `${starts}; segments must be in order of their first word`;
  const where = interleaves
    .map(({ fromSecs, toSecs }) =>
      fromSecs === toSecs
        ? `at ${formatClock(fromSecs)}`
        : `from ${formatClock(fromSecs)} to ${formatClock(toSecs)}`,
    )
    .join(", ");
  return `${starts}, and its words mix with an earlier segment's ${where}; segments must not interleave`;
}

/**
 * A segment that starts before an earlier one's last word, with the earlier
 * segments its words mix with.
 */
export function rule(meeting: RuleMeeting): SegmentOutOfOrder[] {
  const results: SegmentOutOfOrder[] = [];
  const spans: Span[] = [];
  meeting.segments.forEach(({ words }, segmentIndex) => {
    if (words.length === 0) return;
    const first = words[0]!.start;
    const last = Math.max(...words.map((w) => w.start));
    const after = spans.filter((p) => first < p.last);
    if (after.length) {
      // Sorting puts whichever starts first ahead; the two stay out of
      // order if the other starts before its last word.
      const interleaves = after
        .filter((p) => p.first <= first || p.first < last)
        .map((p) => ({
          segmentIndex: p.segmentIndex,
          fromSecs: Math.max(p.first, first),
          toSecs: Math.min(p.last, last),
        }));
      const prevLast = Math.max(...after.map((p) => p.last));
      results.push({
        code,
        message: describe(first, prevLast, interleaves),
        segmentIndex,
        wordIndex: 0,
        atSecs: first,
        previousLastWordSecs: prevLast,
        interleaves,
      });
    }
    spans.push({ segmentIndex, first, last });
  });
  return results;
}

/**
 * Puts segments in order of their first word, leaving any without words where
 * they are. Segments that interleave stay out of order: the data doesn't say
 * which of their words belong to which speaker.
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
