// The rules a meeting's data must follow, wherever it lives: rows in the
// database (checked by @open-minutes/agents after every edit) or golden
// fixture files (checked by @open-minutes/fixtures). Each caller loads the
// meeting into a RuleMeeting, runs checkMeeting, and maps the indices in
// each issue back to whatever its readers can act on: row ids, or file:line.
//
// A rule is a function from the meeting to the violations it finds, in its
// own file named for its code. Each violation has a code and a message, plus
// whatever structured data an agent needs to fix it. Helpers more than one
// rule needs go in ./common.ts. To add a rule, write one, add it to RULES,
// and give its code a severity in SEVERITY. Severity is the harness's call,
// not the rule's: errors are data that is wrong (a write that introduces one
// is rolled back, and a fixture with one fails the tests); warnings are data
// that is probably wrong, or breaks a convention, and wants a look.

import { chapterSize } from "./chapter-size";
import type { Rule, RuleMeeting } from "./common";
import { emptySegment } from "./empty-segment";
import { invalidChapter } from "./invalid-chapter";
import { noBodies } from "./no-bodies";
import { segmentOutOfOrder } from "./segment-out-of-order";
import { splitSentence } from "./split-sentence";
import { uncleanWord } from "./unclean-word";
import { uncoveredSpeech } from "./uncovered-speech";
import { wordOutOfOrder } from "./word-out-of-order";

export type {
  AtWord,
  InChapter,
  InSegment,
  Rule,
  RuleMeeting,
  RuleSegment,
  Violation,
} from "./common";
export { chapterSize, type ChapterSize } from "./chapter-size";
export { emptySegment, type EmptySegment } from "./empty-segment";
export { invalidChapter, type InvalidChapter } from "./invalid-chapter";
export { noBodies, type NoBodies } from "./no-bodies";
export {
  segmentOutOfOrder,
  type SegmentOutOfOrder,
} from "./segment-out-of-order";
export { splitSentence, type SplitSentence } from "./split-sentence";
export { uncleanWord, type UncleanWord } from "./unclean-word";
export { uncoveredSpeech, type UncoveredSpeech } from "./uncovered-speech";
export { wordOutOfOrder, type WordOutOfOrder } from "./word-out-of-order";

/** The rules that look only at the transcript. */
export const TRANSCRIPT_RULES = [
  emptySegment,
  segmentOutOfOrder,
  wordOutOfOrder,
  uncleanWord,
  splitSentence,
] as const;

/** The rules on the chapters, against the transcript. */
export const CHAPTER_RULES = [
  invalidChapter,
  chapterSize,
  uncoveredSpeech,
] as const;

export const RULES = [noBodies, ...TRANSCRIPT_RULES, ...CHAPTER_RULES] as const;

/** What a rule finds, unwrapped from any promise and array. */
type ViolationOf<R> = R extends (meeting: RuleMeeting) => infer Out
  ? Awaited<Out> extends readonly (infer V)[]
    ? V
    : Awaited<Out>
  : never;

type AnyViolation = ViolationOf<(typeof RULES)[number]>;

export type RuleCode = AnyViolation["code"];

/**
 * What one of {@link RULES} can find: by default any of them, or with a code,
 * only that rule's, eg `MeetingViolation<"split-sentence">`.
 */
export type MeetingViolation<C extends RuleCode = RuleCode> = Extract<
  AnyViolation,
  { code: C }
>;

export type Severity = "error" | "warning";

export const SEVERITY = {
  "no-bodies": "error",
  "empty-segment": "error",
  "segment-out-of-order": "error",
  "word-out-of-order": "error",
  "unclean-word": "error",
  "split-sentence": "warning",
  "invalid-chapter": "error",
  "chapter-size": "warning",
  "uncovered-speech": "warning",
} as const satisfies Record<RuleCode, Severity>;

/** A violation, with the severity it is reported at. Narrows by code likewise. */
export type MeetingIssue<C extends RuleCode = RuleCode> =
  MeetingViolation<C> & {
    severity: Severity;
  };

/** Run rules on a meeting: by default all of {@link RULES}, in order. */
export async function checkMeeting(
  meeting: RuleMeeting,
  rules: readonly Rule<MeetingViolation>[] = RULES,
): Promise<MeetingIssue[]> {
  const found = await Promise.all(rules.map((rule) => rule(meeting)));
  return found
    .flat()
    .map((violation) => ({ ...violation, severity: SEVERITY[violation.code] }));
}
