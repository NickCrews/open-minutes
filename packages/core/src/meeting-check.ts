// The rules a meeting's data must follow, wherever it lives: rows in the
// database (checked by @open-minutes/agents after every edit) or golden
// fixture files (checked by @open-minutes/fixtures). Each caller loads the
// meeting into a CheckedMeeting, runs checkMeeting, and maps the indices in
// each issue back to whatever its readers can act on: row ids, or file:line.
//
// Errors are data that is wrong: a write that introduces one is rolled back,
// and a fixture with one fails the tests. Warnings are data that is probably
// wrong, or breaks a convention, and wants a look.

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

export type Severity = "error" | "warning";

export type IssueCode =
  /** error: the meeting has no body that held it. */
  | "no-bodies"
  /** error: a segment with no words. */
  | "empty-segment"
  /** error: a word starts before the word before it in its segment. */
  | "word-order"
  /** error: a segment starts before the previous one's last word. */
  | "segment-order"
  /** error: a disfluency the pipeline's clean stage removes ("um", "the the"). */
  | "unclean-word"
  /** warning: a speaker change inside a sentence, near a longer pause. */
  | "split-sentence"
  /** error: a chapter that is out of order, overlapping, empty or outside the meeting. */
  | "chapter"
  /** warning: a chapter outside the size conventions. */
  | "chapter-convention"
  /** warning: a long stretch of speech in no chapter. */
  | "uncovered-speech";

export interface MeetingIssue {
  code: IssueCode;
  severity: Severity;
  message: string;
  /** Index into `segments`. */
  segment?: number;
  /** Index into that segment's words. */
  word?: number;
  /** Index into `chapters`. */
  chapter?: number;
  /** Seconds into the meeting, where the problem is. */
  at?: number;
}

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

/** Every problem with a meeting's bodies, transcript and chapters. */
export function checkMeeting(meeting: CheckedMeeting): MeetingIssue[] {
  const issues: MeetingIssue[] = [];
  if (meeting.bodyCount === 0)
    issues.push({
      code: "no-bodies",
      severity: "error",
      message: "the meeting has no bodies",
    });
  issues.push(...checkTranscript(meeting.segments));
  if (meeting.chapters?.length)
    issues.push(
      ...checkChapters(
        meeting.chapters,
        meeting.segments,
        meeting.durationSecs ?? undefined,
      ),
    );
  return issues;
}

/**
 * Problems with a transcript on its own. Errors: an empty segment, words or
 * segments out of time order, and disfluencies the pipeline's clean stage
 * would have removed (see transcription/clean.ts). Warnings: a speaker change
 * inside a sentence, a few words from a clearly longer pause (see
 * transcription/turn-edges.ts).
 */
export function checkTranscript(
  segments: readonly CheckedSegment[],
): MeetingIssue[] {
  const issues: MeetingIssue[] = [];
  let prevLast = -Infinity;
  segments.forEach((seg, s) => {
    const { words } = seg;
    if (words.length === 0) {
      issues.push({
        code: "empty-segment",
        severity: "error",
        message: "a segment with no words",
        segment: s,
      });
      return;
    }
    if (words[0]!.start < prevLast)
      issues.push({
        code: "segment-order",
        severity: "error",
        message: `starts at ${formatClock(words[0]!.start)}, before the previous segment's last word (${formatClock(prevLast)}); segments must not interleave`,
        segment: s,
        word: 0,
        at: words[0]!.start,
      });
    words.forEach((w, i) => {
      const prev = words[i - 1];
      if (prev && w.start < prev.start)
        issues.push({
          code: "word-order",
          severity: "error",
          message: `word onset ${formatClock(w.start)} is before the previous word's (${formatClock(prev.start)}); words must be in time order`,
          segment: s,
          word: i,
          at: w.start,
        });
    });
    prevLast = Math.max(prevLast, ...words.map((w) => w.start));

    for (const c of cleanWords(words).changes) {
      if (c.after !== null) continue; // a knock-on fix, eg a passed-on capital
      // By onset alone: a rule may report a word after an earlier rule recased it.
      const word = words.findIndex((w) => w.start === c.start);
      issues.push({
        code: "unclean-word",
        severity: "error",
        message: `${c.rule} ${JSON.stringify(c.before)} should not be in a transcript`,
        segment: s,
        word,
        at: c.start,
      });
    }
  });

  for (const split of splitSentences(segments)) {
    if (
      segments[split.segment - 1]!.speaker === segments[split.segment]!.speaker
    )
      continue;
    const moved = split.misplaced.map((w) => w.text).join(" ");
    issues.push({
      code: "split-sentence",
      severity: "warning",
      message: `speaker change at ${formatClock(split.start)} splits a sentence; the pause at ${formatClock(split.edgeStart)} is longer (${split.edgePause}s vs ${split.pause}s), so ${JSON.stringify(moved)} may belong to the other speaker. Move the boundary to the sentence edge where the voice changes`,
      segment: split.segment,
      at: split.start,
    });
  }
  return issues;
}

/**
 * Problems with a meeting's chapters, against the rules in ./chapters.ts:
 * errors for chapters that are out of order, overlapping or outside the
 * meeting; warnings for broken size conventions and for speech no chapter
 * covers. The meeting ends at `durationSecs` or its last word, whichever is
 * later.
 */
export function checkChapters(
  chapters: readonly ChapterSpan[],
  segments: readonly CheckedSegment[],
  durationSecs?: number,
): MeetingIssue[] {
  const issues: MeetingIssue[] = [];
  const speech = segments
    .filter((s) => s.words.length > 0)
    .map((s) => ({
      start: s.words[0]!.start,
      end: s.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
    }));
  const end = Math.max(durationSecs ?? 0, ...speech.map((s) => s.end));
  const about = (c: number) => ({
    chapter: c,
    at: chapters[c]!.start,
    prefix: `chapter ${c + 1} (${JSON.stringify(chapters[c]!.title)})`,
  });
  for (const e of chapterErrors(chapters, end)) {
    const { prefix, ...where } = about(e.chapter);
    issues.push({
      code: "chapter",
      severity: "error",
      message: `${prefix} ${e.message}`,
      ...where,
    });
  }
  for (const w of chapterWarnings(chapters)) {
    const { prefix, ...where } = about(w.chapter);
    issues.push({
      code: "chapter-convention",
      severity: "warning",
      message: `${prefix} ${w.message}`,
      ...where,
    });
  }
  for (const gap of uncoveredSpeech(speech, chapters)) {
    issues.push({
      code: "uncovered-speech",
      severity: "warning",
      message: `speech from ${formatClock(gap.start)} to ${formatClock(gap.end)} is in no chapter; extend a neighbouring chapter or add one`,
      at: gap.start,
    });
  }
  return issues;
}
