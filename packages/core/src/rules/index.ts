// The rules a meeting's data must follow. @open-minutes/fixtures checks the
// golden fixture files against them. A caller loads the meeting into a
// RuleMeeting, runs checkMeeting, and maps the indices in each issue back to
// whatever its readers can act on, such as file:line.
//
// Each rule is a module named for its code that exports a RuleSpec: its
// `code`, `rule` (a function from the meeting to the violations it finds),
// `defaultSeverity`, and, if a machine can fix what it finds, `fix`, which
// fixMeeting applies. Callers find a rule by its code in
// RULE_SPECS_BY_CODE. Each violation has a code and a message, plus whatever
// structured data an agent needs to fix it. Helpers more than one rule needs
// go in ./common.ts. To add a rule, write its module and add it to
// RULE_SPECS, or to BODY_RULE_SPECS if only some bodies follow it; its code
// and violation type follow from it.

import * as agendaItem from "./agenda-item";
import * as billNumber from "./bill-number";
import * as chapterSize from "./chapter-size";
import type { RuleMeeting, RuleSpec, Severity } from "./common";
import * as codeSection from "./code-section";
import * as date from "./date";
import * as emptySegment from "./empty-segment";
import * as falseStart from "./false-start";
import * as fillerWord from "./filler-word";
import * as foldedAnswer from "./folded-answer";
import * as invalidChapter from "./invalid-chapter";
import * as money from "./money";
import * as monthCapital from "./month-capital";
import * as noBodies from "./no-bodies";
import * as percent from "./percent";
import * as segmentOutOfOrder from "./segment-out-of-order";
import * as spelledNumber from "./spelled-number";
import * as splitNumeral from "./split-numeral";
import * as splitSentence from "./split-sentence";
import * as spokenSeparator from "./spoken-separator";
import * as stutter from "./stutter";
import * as tally from "./tally";
import * as time from "./time";
import * as typographicDash from "./typographic-dash";
import * as uncoveredSpeech from "./uncovered-speech";
import * as wordOutOfOrder from "./word-out-of-order";
import * as zoningDistrict from "./zoning-district";

export type { RuleMeeting, RuleSegment, Severity } from "./common";
export {
  CLEANING_RULE_SPECS,
  cleanGroups,
  cleanSpeechRuns,
  cleanWords,
} from "./clean";

/**
 * The rules every meeting follows, in the order
 * checkMeeting reports them.
 */
export const RULE_SPECS = [
  noBodies,
  emptySegment,
  segmentOutOfOrder,
  wordOutOfOrder,
  typographicDash,
  fillerWord,
  falseStart,
  stutter,
  splitSentence,
  foldedAnswer,
  spokenSeparator,
  time,
  money,
  percent,
  date,
  monthCapital,
  tally,
  spelledNumber,
  splitNumeral,
  invalidChapter,
  chapterSize,
  uncoveredSpeech,
] as const satisfies readonly RuleSpec[];

/** The rules that apply to a transcript on its own. */
export const TRANSCRIPT_RULE_SPECS = [
  emptySegment,
  segmentOutOfOrder,
  wordOutOfOrder,
  typographicDash,
  fillerWord,
  falseStart,
  stutter,
  splitSentence,
  foldedAnswer,
  spokenSeparator,
  time,
  money,
  percent,
  date,
  monthCapital,
  tally,
  spelledNumber,
  splitNumeral,
] as const satisfies readonly RuleSpec[];

/** The rules that apply to chapters, against their transcript. */
export const CHAPTER_RULE_SPECS = [
  invalidChapter,
  typographicDash,
  chapterSize,
  uncoveredSpeech,
] as const satisfies readonly RuleSpec[];

/**
 * Body-specific rules: those only some bodies follow, such as Anchorage's
 * ways of numbering its bills, code sections, agenda items and zoning
 * districts. A body opts into each by its code. For now only the golden
 * fixtures say which they follow, with `_rules` in bodies.jsonl.
 */
export const BODY_RULE_SPECS = [
  billNumber,
  codeSection,
  agendaItem,
  zoningDistrict,
] as const satisfies readonly RuleSpec[];

type AnyRuleSpec =
  | (typeof RULE_SPECS)[number]
  | (typeof BODY_RULE_SPECS)[number];

export type RuleCode = AnyRuleSpec["code"];

/** Each rule's spec, by its code. */
export const RULE_SPECS_BY_CODE = Object.fromEntries(
  [...RULE_SPECS, ...BODY_RULE_SPECS].map((spec) => [spec.code, spec]),
) as { [S in AnyRuleSpec as S["code"]]: S };

type Unarray<T> = T extends readonly (infer V)[] ? V : T;

/** What a rule finds, unwrapped from any promise and array. */
type ViolationOf<R> = R extends (meeting: RuleMeeting) => infer Out
  ? Unarray<Awaited<Out>>
  : never;

type AnyViolation = ViolationOf<AnyRuleSpec["rule"]>;

/**
 * What one of {@link RULE_SPECS} or {@link BODY_RULE_SPECS} can find: by
 * default any of them, or with a code, only that rule's, eg
 * `MeetingViolation<"split-sentence">`.
 */
export type MeetingViolation<C extends RuleCode = RuleCode> = Extract<
  AnyViolation,
  { code: C }
>;

/** A violation, with the severity it is reported at. Narrows by code likewise. */
export type MeetingIssue<C extends RuleCode = RuleCode> =
  MeetingViolation<C> & {
    severity: Severity;
  };

/** What running these specs can report: each one's violations, with a severity. */
type IssueOf<S extends RuleSpec<MeetingViolation>> = ViolationOf<S["rule"]> & {
  severity: Severity;
};

/**
 * Run rules on a meeting, by default all of {@link RULE_SPECS} in order, and
 * report each violation at its rule's default severity. The result's type
 * holds only the violations the given specs can find.
 */
export async function checkMeeting<
  const S extends readonly RuleSpec<MeetingViolation>[] = typeof RULE_SPECS,
>(
  meeting: RuleMeeting,
  specs: S = RULE_SPECS as unknown as S,
): Promise<IssueOf<S[number]>[]> {
  const found = await Promise.all(
    specs.map(async ({ rule, defaultSeverity }) =>
      [await rule(meeting)].flat().map((violation) => ({
        ...violation,
        severity: defaultSeverity,
      })),
    ),
  );
  return found.flat() as unknown as IssueOf<S[number]>[];
}

/** How many times fixMeeting runs the fixes before giving up on them settling. */
const MAX_FIX_PASSES = 10;

/**
 * Apply the fixes of the given rules, by default all of {@link RULE_SPECS},
 * until they change nothing: one rule's fix can leave work for another's, as
 * cleaning a segment's words can empty it. Returns the fixed meeting, the one
 * given if nothing changed, and the violations the fixes resolved, at their
 * rule's default severity. A violation's indices are into the meeting as it
 * was when its fix ran. What the fixes can't resolve is left for
 * {@link checkMeeting} to report.
 */
export async function fixMeeting<
  M extends RuleMeeting,
  const S extends readonly RuleSpec<MeetingViolation>[] = typeof RULE_SPECS,
>(
  meeting: M,
  specs: S = RULE_SPECS as unknown as S,
): Promise<{ meeting: M; fixed: IssueOf<S[number]>[] }> {
  const fixed: (MeetingViolation & { severity: Severity })[] = [];
  let current = meeting;
  for (let pass = 0; ; pass++) {
    const before = current;
    for (const { rule, fix, defaultSeverity } of specs) {
      if (!fix) continue;
      const result = fix(current, [await rule(current)].flat());
      current = result.meeting;
      for (const v of result.fixed)
        fixed.push({ ...v, severity: defaultSeverity });
    }
    if (current === before) break;
    if (pass === MAX_FIX_PASSES)
      throw new Error(`fixes still changing the meeting after ${pass} passes`);
  }
  return { meeting: current, fixed: fixed as IssueOf<S[number]>[] };
}
