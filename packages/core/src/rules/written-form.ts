import {
  findWrittenFormIssues,
  WRITTEN_FORM_RULES,
  type WrittenFormRule,
} from "../transcription";
import {
  type AtWord,
  type Rule,
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
 * A rule for numbers, times, sums, dates and identifiers not written the
 * transcript's way ("ten dollars", "11 15 AM", and with Anchorage's rules "AR
 * 2026 48"; see transcription/written-form.ts), by the given written-form
 * rules.
 */
export function ruleBy(rules: readonly WrittenFormRule[]): Rule<WrittenForm> {
  return (meeting) =>
    wordIssues(meeting, code, (words) => findWrittenFormIssues(words, rules));
}

/** By the written-form rules for anywhere: WRITTEN_FORM_RULES. */
export const rule = ruleBy(WRITTEN_FORM_RULES);
