import type { InSegment, RuleMeeting, Severity, Violation } from "./common";

export type EmptySegment = Violation<"empty-segment"> & InSegment;

export const defaultSeverity = "error" satisfies Severity;

/** A segment with no words. */
export function rule(meeting: RuleMeeting): EmptySegment[] {
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
