import { spelledNumbers, splitNumerals } from "../transcription";
import {
  type AtWord,
  type RuleMeeting,
  type Severity,
  type Violation,
  wordIssues,
} from "./common";

export const code = "spelled-number";

export type SpelledNumber = Violation<typeof code> &
  AtWord & {
    /** "spelled-number" or "split-numeral". */
    rule: string;
    /** The words at fault. */
    text: string;
  };

export const defaultSeverity = "warning" satisfies Severity;

/**
 * Number words the style writes as numerals ("twenty twenty six", "eleven"),
 * and two numerals in a row that are probably one ("2026 48").
 */
export function rule(meeting: RuleMeeting): SpelledNumber[] {
  return wordIssues(meeting, code, (words) => [
    ...spelledNumbers(words),
    ...splitNumerals(words),
  ]);
}
