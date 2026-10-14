// The rules a meeting's data must follow, wherever it lives: rows in the
// database (checked by @open-minutes/agents after every edit) or golden
// fixture files (checked by @open-minutes/fixtures). Each caller loads the
// meeting into a RuleMeeting, runs checkMeeting, and maps the indices in
// each issue back to whatever its readers can act on: row ids, or file:line.
//
// Each rule is a module named for its code that exports a RuleSpec: its
// `code`, `rule` (a function from the meeting to the violations it finds),
// `defaultSeverity`, and, if a machine can fix what it finds, `fix`, which
// fixMeeting applies. Callers find a rule by its code in
// RULE_SPECS_BY_CODE. Each violation has a code and a message, plus whatever
// structured data an agent needs to fix it. Helpers more than one rule needs
// go in ./common.ts. To add a rule, write its module and add it to
// RULE_SPECS; its code and violation type follow from it.

import * as chapterSize from "./chapter-size";
import type { RuleMeeting, RuleSpec, Severity, Violation } from "./common";
import * as emptySegment from "./empty-segment";
import * as invalidChapter from "./invalid-chapter";
import * as noBodies from "./no-bodies";
import * as segmentOutOfOrder from "./segment-out-of-order";
import * as splitSentence from "./split-sentence";
import * as uncleanWord from "./unclean-word";
import * as uncoveredSpeech from "./uncovered-speech";
import * as wordOutOfOrder from "./word-out-of-order";

export type { RuleMeeting, RuleSegment } from "./common";
/** The rules that look only at the transcript. */
export const TRANSCRIPT_RULE_SPECS = [
  emptySegment,
  segmentOutOfOrder,
  wordOutOfOrder,
  uncleanWord,
  splitSentence,
] as const satisfies readonly RuleSpec[];

/** The rules on the chapters, against the transcript. */
export const CHAPTER_RULE_SPECS = [
  invalidChapter,
  chapterSize,
  uncoveredSpeech,
] as const satisfies readonly RuleSpec[];

const RULE_SPECS = [
  noBodies,
  ...TRANSCRIPT_RULE_SPECS,
  ...CHAPTER_RULE_SPECS,
] as const satisfies readonly RuleSpec[];

type AnyRuleSpec = (typeof RULE_SPECS)[number];

export type RuleCode = AnyRuleSpec["code"];

/** Each rule's spec, by its code. */
export const RULE_SPECS_BY_CODE = Object.fromEntries(
  RULE_SPECS.map((spec) => [spec.code, spec]),
) as { [S in AnyRuleSpec as S["code"]]: S };

type Unarray<T> = T extends readonly (infer V)[] ? V : T;

/** What a rule finds, unwrapped from any promise and array. */
type ViolationOf<R> = R extends (meeting: RuleMeeting) => infer Out
  ? Unarray<Awaited<Out>>
  : never;

type AnyViolation = ViolationOf<AnyRuleSpec["rule"]>;

/**
 * What one of {@link RULE_SPECS} can find: by default any of them, or with a code,
 * only that rule's, eg `MeetingViolation<"split-sentence">`.
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

/** A JSON string in a message, eg a word or a chapter's title. */
const QUOTED = /"(?:[^"\\]|\\.)*"/g;

/** How many times fixMeeting runs the fixes before giving up on them settling. */
const MAX_FIX_PASSES = 10;

/**
 * Apply the fixes of the given rules, by default all of {@link RULE_SPECS},
 * until they change nothing: one rule's fix can leave work for another's, as
 * cleaning a segment's words can empty it. Returns the fixed meeting, the one
 * given if nothing changed, and the violations it fixed: those found before
 * and not after, matched by code, `atSecs` and message, ignoring the quoted
 * text in messages that a fix may have changed, eg a chapter's title. What
 * the fixes can't resolve is left for {@link checkMeeting} to report.
 */
export async function fixMeeting<
  M extends RuleMeeting,
  const S extends readonly RuleSpec<MeetingViolation>[] = typeof RULE_SPECS,
>(
  meeting: M,
  specs: S = RULE_SPECS as unknown as S,
): Promise<{ meeting: M; fixed: IssueOf<S[number]>[] }> {
  const fixable = specs.filter((spec) => spec.fix);
  let current = meeting;
  for (let pass = 0; ; pass++) {
    const next = fixable.reduce((m, spec) => spec.fix!(m), current);
    if (next === current) break;
    if (pass === MAX_FIX_PASSES)
      throw new Error(`fixes still changing the meeting after ${pass} passes`);
    current = next;
  }
  if (current === meeting) return { meeting, fixed: [] };

  const key = (v: Violation & { atSecs?: number }) =>
    [v.code, v.atSecs, v.message.replace(QUOTED, '""')].join("\0");
  const left = new Map<string, number>();
  for (const v of await checkMeeting(current, fixable))
    left.set(key(v), (left.get(key(v)) ?? 0) + 1);
  const fixed = (await checkMeeting(meeting, fixable)).filter((v) => {
    const n = left.get(key(v)) ?? 0;
    if (n === 0) return true;
    left.set(key(v), n - 1);
    return false;
  });
  return { meeting: current, fixed: fixed as IssueOf<S[number]>[] };
}
