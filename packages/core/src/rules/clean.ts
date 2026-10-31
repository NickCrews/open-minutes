// Transcript cleaning: the fixes of the rules that hold a transcript to
// written form, applied to raw recognizer output before it is aligned or
// stored. The recognizer transcribes verbatim, so its output is full of
// disfluencies (hesitations, stutters, abandoned word fragments) that make a
// transcript harder to read without adding anything a reader of meeting
// minutes needs, and of typographic dashes where stored text has hyphens.
//
// The rules are deliberately conservative: a missed disfluency costs a little
// readability, but deleting a word someone actually meant changes the record.

import type { Segment, Word } from "../transcript";
import type { SpeechRun } from "../transcription";
import type { RuleMeeting, RuleSpec, Violation } from "./common";
import * as falseStart from "./false-start";
import * as fillerWord from "./filler-word";
import * as stutter from "./stutter";
import * as typographicDash from "./typographic-dash";

/** The rules whose fixes clean a transcript, in the order they run. */
export const CLEANING_RULE_SPECS = [
  typographicDash,
  fillerWord,
  falseStart,
  stutter,
] as const;

/** How many times a clean runs the fixes before giving up on them settling. */
const MAX_PASSES = 10;

/**
 * Apply the cleaning rules' fixes to each group's words (a speaker's segment,
 * a VAD run) until they change nothing. A fix never reaches across groups,
 * since the next may be another speaker ("Yes." / "Yes." on a roll call is
 * not a stutter). Groups keep their other properties, and kept words their
 * onsets and other properties; a group may be left with no words.
 */
export function cleanGroups<G extends Segment<string | number>>(
  groups: readonly G[],
): G[] {
  let meeting: RuleMeeting & { segments: readonly G[] } = { segments: groups };
  for (let pass = 0; ; pass++) {
    const before = meeting;
    for (const spec of CLEANING_RULE_SPECS as readonly RuleSpec<Violation>[]) {
      const violations = spec.rule(meeting) as Violation[];
      meeting = spec.fix!(meeting, violations).meeting;
    }
    if (meeting === before) return [...meeting.segments];
    if (pass === MAX_PASSES)
      throw new Error(`cleaning still changing words after ${pass} passes`);
  }
}

/** {@link cleanGroups} for one continuous run of words. */
export function cleanWords<W extends Word>(words: readonly W[]): W[] {
  return cleanGroups([
    { speakerNumber: null, person: null, words: [...words] },
  ])[0]!.words as W[];
}

/** The pipeline's clean stage: {@link cleanGroups} over transcribeAudio's VAD runs. */
export function cleanSpeechRuns(runs: readonly SpeechRun[]): SpeechRun[] {
  const cleaned = cleanGroups(
    runs.map((s) => ({ speakerNumber: null, person: null, words: s.words })),
  );
  return runs.map((s, i) => ({ ...s, words: [...cleaned[i]!.words] }));
}
