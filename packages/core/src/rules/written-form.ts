import { findWrittenFormIssues } from "../transcription";
import {
  type AtWord,
  type RuleMeeting,
  type Severity,
  type Violation,
  wordIssues,
} from "./common";

export const code = "written-form";

export type WrittenForm = Violation<typeof code> &
  AtWord & {
    /** The written-form rule it breaks, eg "bill-number". */
    rule: string;
    /** The words at fault. */
    text: string;
  };

export const defaultSeverity = "error" satisfies Severity;

/**
 * A number, time, sum, date or identifier not written the transcript's way
 * ("AR 2026 48", "ten dollars", "11 15 AM"; see transcription/written-form.ts).
 */
export function rule(meeting: RuleMeeting): WrittenForm[] {
  return wordIssues(meeting, code, (words) => findWrittenFormIssues(words));
}
