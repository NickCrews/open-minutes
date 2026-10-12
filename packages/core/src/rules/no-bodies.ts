import type { RuleMeeting, Violation } from "./common";

export type NoBodies = Violation<"no-bodies">;

/** A meeting held by no body. */
export function noBodies(meeting: RuleMeeting): NoBodies[] {
  return meeting.bodyCount === 0
    ? [{ code: "no-bodies", message: "the meeting has no bodies" }]
    : [];
}
