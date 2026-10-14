// The types every rule shares, and helpers for more than one rule.

import type { ChapterSpan } from "../chapters";
import { LAST_WORD_DURATION_SEC, type TranscriptWord } from "../transcription";

export interface RuleSegment {
  /**
   * Who spoke it, as a key: segments with equal keys are the same speaker.
   * Null for unattributed speech.
   */
  speaker: string | null;
  words: readonly TranscriptWord[];
}

/** A meeting as the rules take it. */
export interface RuleMeeting {
  /** Absent when unknown, as is `description`. */
  title?: string;
  description?: string;
  /** How many bodies held it. Absent when unknown, eg for a transcript on its own. */
  bodyCount?: number;
  durationSecs?: number | null;
  /** In the order they're stored. */
  segments: readonly RuleSegment[];
  /** In order. Empty, null or absent when the meeting has none. */
  chapters?: readonly ChapterSpan[] | null;
}

/** One problem a rule found. Rules add the data needed to fix it. */
export interface Violation<Code extends string = string> {
  code: Code;
  message: string;
}

export type Rule<V extends Violation = Violation> = (
  meeting: RuleMeeting,
) => V | V[] | Promise<V | V[]>;

/** What a fix returns: the fixed meeting, and which violations it fixed. */
export interface Fixed<M extends RuleMeeting, V extends Violation> {
  /** The meeting given when there was nothing to change. */
  meeting: M;
  /** Those of the violations it was given that it resolved. */
  fixed: V[];
}

/**
 * `error`: the data is wrong, and a fixture with one fails the tests.
 * `warning`: the data is probably wrong, or breaks a convention, and wants a
 * look.
 */
export type Severity = "error" | "warning";

/** What each rule's module exports. */
export interface RuleSpec<V extends Violation = Violation> {
  code: V["code"];
  rule: Rule<V>;
  /** What its violations are reported as. */
  defaultSeverity: Severity;
  /**
   * For a rule whose violations a machine can fix: rewrites the meeting to
   * resolve those of `violations` (what `rule` found in it) that need no
   * judgment, and says which they were. Segments and chapters keep any
   * properties beyond what the rules look at.
   */
  fix?<M extends RuleMeeting>(
    meeting: M,
    violations: readonly V[],
  ): Fixed<M, V>;
}

/** In a segment. */
export interface InSegment {
  /** An index into `segments`. */
  segmentIndex: number;
}

/** At a word. */
export interface AtWord extends InSegment {
  /** An index into the segment's words. */
  wordIndex: number;
  /** The word's onset. */
  atSecs: number;
}

/** In a chapter. */
export interface InChapter {
  /** An index into `chapters`. */
  chapterIndex: number;
  /** The chapter's start. */
  atSecs: number;
}

/** Each non-empty segment's span, from its first word to its last's end. */
export function speechSpans(meeting: RuleMeeting) {
  return meeting.segments
    .filter((s) => s.words.length > 0)
    .map((s) => ({
      start: s.words[0]!.start,
      end: s.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
    }));
}

export function chapterName(
  chapters: readonly ChapterSpan[],
  i: number,
): string {
  return `chapter ${i + 1} (${JSON.stringify(chapters[i]!.title)})`;
}
