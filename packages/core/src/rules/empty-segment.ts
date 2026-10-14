import type {
  Fix,
  InSegment,
  RuleMeeting,
  Severity,
  Violation,
} from "./common";

export const code = "empty-segment";

export type EmptySegment = Violation<typeof code> & InSegment;

export const defaultSeverity = "error" satisfies Severity;

/** A segment with no words. */
export function rule(meeting: RuleMeeting): EmptySegment[] {
  return meeting.segments.flatMap((seg, segment) =>
    seg.words.length === 0
      ? [
          {
            code,
            message: "a segment with no words",
            segmentIndex: segment,
          },
        ]
      : [],
  );
}

/** Drops the segments with no words. */
export const fix: Fix = (meeting) =>
  meeting.segments.every((seg) => seg.words.length > 0)
    ? meeting
    : {
        ...meeting,
        segments: meeting.segments.filter((seg) => seg.words.length > 0),
      };
