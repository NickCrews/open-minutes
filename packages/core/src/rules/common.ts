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
  /** How many bodies held it. Leave out to skip the no-bodies rule. */
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

/** In a segment: an index into `segments`. */
export interface InSegment {
  segment: number;
}

/** At a word: an index into `segments` and into that segment's words. */
export interface AtWord extends InSegment {
  word: number;
  /** The word's onset, in seconds. */
  at: number;
}

/** In a chapter: an index into `chapters`. */
export interface InChapter {
  chapter: number;
  /** The chapter's start, in seconds. */
  at: number;
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
