import type { RuleMeeting, Severity, Violation } from "./common";

export const code = "no-bodies";

export type NoBodies = Violation<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/** A meeting held by no body. Says nothing when the body count is unknown. */
export function rule(meeting: RuleMeeting): NoBodies[] {
  return meeting.bodyCount === 0
    ? [{ code, message: "the meeting has no bodies" }]
    : [];
}
