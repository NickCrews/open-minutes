// The rules a meeting's data must follow, wherever it lives: rows in the
// database (checked by @open-minutes/agents after every edit) or golden
// fixture files (checked by @open-minutes/fixtures). Each caller loads the
// meeting into a CheckedMeeting, runs checkMeeting, and maps the indices in
// each issue back to whatever its readers can act on: row ids, or file:line.
//
// A check is a function from the meeting to the problems it finds. Each
// result has a code and a message, plus whatever structured data an agent
// needs to fix it. To add a check, write one, add it to CHECKERS, and give
// its code a severity in SEVERITY. Severity is the harness's call, not the
// check's: errors are data that is wrong (a write that introduces one is
// rolled back, and a fixture with one fails the tests); warnings are data
// that is probably wrong, or breaks a convention, and wants a look.

import {
  type ChapterSpan,
  chapterErrors,
  chapterWarnings,
  uncoveredSpeech,
} from "./chapters";
import { formatClock } from "./clock";
import {
  cleanWords,
  LAST_WORD_DURATION_SEC,
  splitSentences,
  type TranscriptWord,
} from "./transcription";

export interface CheckedSegment {
  /**
   * Who spoke it, as a key: segments with equal keys are the same speaker.
   * Null for unattributed speech.
   */
  speaker: string | null;
  words: readonly TranscriptWord[];
}

export interface CheckedMeeting {
  /** How many bodies held it. Leave out to skip that check. */
  bodyCount?: number;
  durationSecs?: number | null;
  /** In the order they're stored. */
  segments: readonly CheckedSegment[];
  /** In order. Empty, null or absent when the meeting has none. */
  chapters?: readonly ChapterSpan[] | null;
}

/** One problem a check found. Checks add the data needed to fix it. */
export interface CheckResult<Code extends string = string> {
  code: Code;
  message: string;
}

export type Checker<R extends CheckResult = CheckResult> = (
  meeting: CheckedMeeting,
) => R | R[] | Promise<R | R[]>;

/** In a segment: an index into `segments`. */
interface InSegment {
  segment: number;
}

/** At a word: an index into `segments` and into that segment's words. */
interface AtWord extends InSegment {
  word: number;
  /** The word's onset, in seconds. */
  at: number;
}

/** In a chapter: an index into `chapters`. */
interface InChapter {
  chapter: number;
  /** The chapter's start, in seconds. */
  at: number;
}

type NoBodies = CheckResult<"no-bodies">;

export function checkBodies(meeting: CheckedMeeting): NoBodies[] {
  return meeting.bodyCount === 0
    ? [{ code: "no-bodies", message: "the meeting has no bodies" }]
    : [];
}

type EmptySegment = CheckResult<"empty-segment"> & InSegment;

export function checkEmptySegments(meeting: CheckedMeeting): EmptySegment[] {
  return meeting.segments.flatMap((seg, segment) =>
    seg.words.length === 0
      ? [
          {
            code: "empty-segment" as const,
            message: "a segment with no words",
            segment,
          },
        ]
      : [],
  );
}

type SegmentOrder = CheckResult<"segment-order"> &
  AtWord & {
    /** Onset of the latest word in the segments before it. */
    previousLastWord: number;
  };

/** A segment that starts before an earlier one's last word. */
export function checkSegmentOrder(meeting: CheckedMeeting): SegmentOrder[] {
  const results: SegmentOrder[] = [];
  let prevLast = -Infinity;
  meeting.segments.forEach(({ words }, segment) => {
    if (words.length === 0) return;
    const at = words[0]!.start;
    if (at < prevLast)
      results.push({
        code: "segment-order",
        message: `starts at ${formatClock(at)}, before the previous segment's last word (${formatClock(prevLast)}); segments must not interleave`,
        segment,
        word: 0,
        at,
        previousLastWord: prevLast,
      });
    prevLast = Math.max(prevLast, ...words.map((w) => w.start));
  });
  return results;
}

type WordOrder = CheckResult<"word-order"> &
  AtWord & {
    /** Onset of the word before it. */
    previousStart: number;
  };

/** A word that starts before the word before it in its segment. */
export function checkWordOrder(meeting: CheckedMeeting): WordOrder[] {
  return meeting.segments.flatMap(({ words }, segment) =>
    words.flatMap((w, word) => {
      const prev = words[word - 1];
      if (!prev || w.start >= prev.start) return [];
      return [
        {
          code: "word-order" as const,
          message: `word onset ${formatClock(w.start)} is before the previous word's (${formatClock(prev.start)}); words must be in time order`,
          segment,
          word,
          at: w.start,
          previousStart: prev.start,
        },
      ];
    }),
  );
}

type UncleanWord = CheckResult<"unclean-word"> &
  AtWord & {
    /** The cleaning rule that would remove it, eg "filler". */
    rule: string;
    text: string;
  };

/**
 * A disfluency the pipeline's clean stage would have removed ("um", "the
 * the"; see transcription/clean.ts).
 */
export function checkUncleanWords(meeting: CheckedMeeting): UncleanWord[] {
  return meeting.segments.flatMap(({ words }, segment) =>
    cleanWords(words)
      // A word recased, not removed, is a knock-on fix, eg a passed-on capital.
      .changes.filter((c) => c.after === null)
      .map((c) => ({
        code: "unclean-word" as const,
        message: `${c.rule} ${JSON.stringify(c.before)} should not be in a transcript`,
        segment,
        // By onset alone: a rule may report a word after an earlier rule recased it.
        word: words.findIndex((w) => w.start === c.start),
        at: c.start,
        rule: c.rule,
        text: c.before,
      })),
  );
}

type SplitSentence = CheckResult<"split-sentence"> &
  InSegment & {
    /** Onset of the segment's first word. */
    at: number;
    /** Onset of the word after the longer pause, where the turn probably changes. */
    edgeStart: number;
    /** The words between the two, which probably belong to the other speaker. */
    misplaced: string[];
  };

/**
 * A speaker change inside a sentence, a few words from a clearly longer
 * pause (see transcription/turn-edges.ts).
 */
export function checkSplitSentences(meeting: CheckedMeeting): SplitSentence[] {
  const { segments } = meeting;
  return splitSentences(segments)
    .filter(
      (split) =>
        segments[split.segment - 1]!.speaker !==
        segments[split.segment]!.speaker,
    )
    .map((split) => {
      const misplaced = split.misplaced.map((w) => w.text);
      return {
        code: "split-sentence" as const,
        message: `speaker change at ${formatClock(split.start)} splits a sentence; the pause at ${formatClock(split.edgeStart)} is longer (${split.edgePause}s vs ${split.pause}s), so ${JSON.stringify(misplaced.join(" "))} may belong to the other speaker. Move the boundary to the sentence edge where the voice changes`,
        segment: split.segment,
        at: split.start,
        edgeStart: split.edgeStart,
        misplaced,
      };
    });
}

type InvalidChapter = CheckResult<"chapter"> & InChapter;

/**
 * A chapter that is out of order, overlapping, empty or outside the meeting,
 * by the rules in ./chapters.ts. The meeting ends at `durationSecs` or its
 * last word, whichever is later.
 */
export function checkChapterRules(meeting: CheckedMeeting): InvalidChapter[] {
  const chapters = meeting.chapters ?? [];
  const end = Math.max(
    meeting.durationSecs ?? 0,
    ...speechSpans(meeting).map((s) => s.end),
  );
  return chapterErrors(chapters, end).map((e) => ({
    code: "chapter",
    message: `${chapterName(chapters, e.chapter)} ${e.message}`,
    chapter: e.chapter,
    at: chapters[e.chapter]!.start,
  }));
}

type ChapterConvention = CheckResult<"chapter-convention"> & InChapter;

/** A chapter outside the size conventions in ./chapters.ts. */
export function checkChapterConventions(
  meeting: CheckedMeeting,
): ChapterConvention[] {
  const chapters = meeting.chapters ?? [];
  return chapterWarnings(chapters).map((w) => ({
    code: "chapter-convention",
    message: `${chapterName(chapters, w.chapter)} ${w.message}`,
    chapter: w.chapter,
    at: chapters[w.chapter]!.start,
  }));
}

type UncoveredSpeech = CheckResult<"uncovered-speech"> & {
  /** Where the uncovered speech starts, in seconds. */
  at: number;
  end: number;
};

/** A long stretch of speech in no chapter, when the meeting has chapters. */
export function checkUncoveredSpeech(
  meeting: CheckedMeeting,
): UncoveredSpeech[] {
  if (!meeting.chapters?.length) return [];
  return uncoveredSpeech(speechSpans(meeting), meeting.chapters).map((gap) => ({
    code: "uncovered-speech",
    message: `speech from ${formatClock(gap.start)} to ${formatClock(gap.end)} is in no chapter; extend a neighbouring chapter or add one`,
    at: gap.start,
    end: gap.end,
  }));
}

function speechSpans(meeting: CheckedMeeting) {
  return meeting.segments
    .filter((s) => s.words.length > 0)
    .map((s) => ({
      start: s.words[0]!.start,
      end: s.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
    }));
}

function chapterName(chapters: readonly ChapterSpan[], i: number): string {
  return `chapter ${i + 1} (${JSON.stringify(chapters[i]!.title)})`;
}

/** The checks that look only at the transcript. */
export const TRANSCRIPT_CHECKERS = [
  checkEmptySegments,
  checkSegmentOrder,
  checkWordOrder,
  checkUncleanWords,
  checkSplitSentences,
] as const;

/** The checks on the chapters, against the transcript. */
export const CHAPTER_CHECKERS = [
  checkChapterRules,
  checkChapterConventions,
  checkUncoveredSpeech,
] as const;

export const CHECKERS = [
  checkBodies,
  ...TRANSCRIPT_CHECKERS,
  ...CHAPTER_CHECKERS,
] as const;

/** What a checker finds, unwrapped from any promise and array. */
type ResultOf<C> = C extends (meeting: CheckedMeeting) => infer Out
  ? Awaited<Out> extends readonly (infer R)[]
    ? R
    : Awaited<Out>
  : never;

/** Anything one of {@link CHECKERS} can find. */
export type MeetingCheckResult = ResultOf<(typeof CHECKERS)[number]>;

export type IssueCode = MeetingCheckResult["code"];

export type Severity = "error" | "warning";

export const SEVERITY: Record<IssueCode, Severity> = {
  "no-bodies": "error",
  "empty-segment": "error",
  "segment-order": "error",
  "word-order": "error",
  "unclean-word": "error",
  "split-sentence": "warning",
  chapter: "error",
  "chapter-convention": "warning",
  "uncovered-speech": "warning",
};

/** A check's result, with the severity it is reported at. */
export type MeetingIssue = MeetingCheckResult & { severity: Severity };

/** Run checks on a meeting: by default all of {@link CHECKERS}, in order. */
export async function checkMeeting(
  meeting: CheckedMeeting,
  checkers: readonly Checker<MeetingCheckResult>[] = CHECKERS,
): Promise<MeetingIssue[]> {
  const found = await Promise.all(checkers.map((check) => check(meeting)));
  return found
    .flat()
    .map((result) => ({ ...result, severity: SEVERITY[result.code] }));
}
