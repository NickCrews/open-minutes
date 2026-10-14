import type { InSegment, RuleMeeting, Violation } from "./common";

export type EmptySegment = Violation<"empty-segment"> & InSegment;

/** A segment with no words. */
export function emptySegment(meeting: RuleMeeting): EmptySegment[] {
  return meeting.segments.flatMap((seg, segment) =>
    seg.words.length === 0
      ? [
          {
            code: "empty-segment" as const,
            message: "a segment with no words",
            segmentIndex: segment,
          },
        ]
      : [],
  );
}
