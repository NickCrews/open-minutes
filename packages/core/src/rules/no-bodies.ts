import type { RuleMeeting, Severity, Violation } from "./common";

export type NoBodies = Violation<"no-bodies">;

export const defaultSeverity = "error" satisfies Severity;

/** A meeting held by no body. Says nothing when the body count is unknown. */
export function rule(meeting: RuleMeeting): NoBodies[] {
  return meeting.bodyCount === 0
    ? [{ code: "no-bodies", message: "the meeting has no bodies" }]
    : [];
}
