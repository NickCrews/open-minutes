// Not one module per rule: every code in WRITTEN_FORM_CODES gets a spec of
// the same shape here, from its rule in transcription/written-form.ts.

import {
  findWrittenFormIssues,
  spelledNumbers,
  splitNumerals,
  type TranscriptWord,
  type WrittenFormCode,
  type WrittenFormIssue,
  type WrittenFormRule,
} from "../transcription";
import type { AtWord, Rule, Severity, Violation } from "./common";

/**
 * A number, time, sum, date or identifier not written the transcript's way,
 * with a code for each rule in transcription/written-form.ts: "time" for "7
 * pm", "money" for "ten dollars", "spelled-number" for "twenty twenty six".
 */
export type WrittenForm<Code extends WrittenFormCode = WrittenFormCode> =
  Code extends unknown
    ? Violation<Code> &
        AtWord & {
          /** The words at fault. */
          text: string;
        }
    : never;

const SEVERITY = {
  "spoken-separator": "error",
  time: "error",
  money: "error",
  percent: "error",
  date: "error",
  "month-capital": "error",
  tally: "error",
  "bill-number": "error",
  "code-section": "error",
  "agenda-item": "error",
  "zoning-district": "error",
  "spelled-number": "warning",
  "split-numeral": "warning",
} as const satisfies Record<WrittenFormCode, Severity>;

export type WrittenFormSpec<Code extends WrittenFormCode = WrittenFormCode> =
  Code extends unknown
    ? {
        code: Code;
        rule: Rule<WrittenForm<Code>>;
        defaultSeverity: (typeof SEVERITY)[Code];
      }
    : never;

function spec<Code extends WrittenFormCode>(
  code: Code,
  find: (words: readonly TranscriptWord[]) => WrittenFormIssue[],
): WrittenFormSpec<Code> {
  const rule: Rule<WrittenForm<Code>> = (meeting) =>
    meeting.segments.flatMap(({ words }, segment) =>
      find(words).map(
        (f) =>
          ({
            code,
            message: `${JSON.stringify(f.text)}: ${f.message}`,
            segmentIndex: segment,
            wordIndex: f.index,
            atSecs: words[f.index]!.start,
            text: f.text,
          }) as WrittenForm<Code>,
      ),
    );
  return {
    code,
    rule,
    defaultSeverity: SEVERITY[code],
  } as WrittenFormSpec<Code>;
}

/** The spec for one rule in transcription/written-form.ts, eg timeRule. */
export function writtenFormSpec(rule: WrittenFormRule): WrittenFormSpec {
  return spec(rule.name, (words) => findWrittenFormIssues(words, [rule]));
}

/** Number words the style writes as numerals ("twenty twenty six", "eleven"). */
export const spelledNumber = spec("spelled-number", spelledNumbers);

/** Two numerals in a row that are probably one ("2026 48"). */
export const splitNumeral = spec("split-numeral", splitNumerals);
