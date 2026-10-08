import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectSpeech,
  type Span,
  SPEECH_RUNS_VERSION,
} from "@open-minutes/audio/speech-runs";
import { isMusicMarker } from "@open-minutes/core/transcription";
import type { AudioMeeting, LabeledSegment } from "./meeting";

// Where in a meeting someone is talking (Silero VAD, run by the pipeline's
// `detectSpeech`), and arithmetic on those spans against the transcript's
// words.

export type { Span };

/**
 * Every speech run in the meeting, in time order. Computed once per meeting
 * (about 35 s for three hours of audio) and cached next to its audio.
 */
export function speechRuns(meeting: AudioMeeting): Span[] {
  const path = join(meeting.cacheDir, "speech-runs.json");
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      runs: Span[];
    };
    if (cached.version === SPEECH_RUNS_VERSION) return cached.runs;
  }
  console.error(`Finding speech in ${meeting.ref} (once per meeting)...`);
  const runs = detectSpeech(meeting.wave());
  writeFileSync(path, JSON.stringify({ version: SPEECH_RUNS_VERSION, runs }));
  return runs;
}

/** The parts of `spans` inside [from, to], clipped to it. */
export function clip(spans: readonly Span[], from: number, to: number): Span[] {
  return spans
    .filter((s) => s.end > from && s.start < to)
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }));
}

/** Silences between speech runs inside [from, to], at least `minSecs` long. */
export function pauses(
  runs: readonly Span[],
  from: number,
  to: number,
  minSecs: number,
): Span[] {
  const inside = clip(runs, from, to);
  const gaps: Span[] = [];
  let cursor = from;
  for (const r of inside) {
    if (r.start - cursor >= minSecs) gaps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (to - cursor >= minSecs) gaps.push({ start: cursor, end: to });
  return gaps.map((g) => ({ start: round(g.start), end: round(g.end) }));
}

/** Total length of `spans`, which must not overlap. */
export function totalSecs(spans: readonly Span[]): number {
  return spans.reduce((n, s) => n + (s.end - s.start), 0);
}

/**
 * How long one word is assumed to cover after its onset, at most. Words
 * carry only onsets; a word runs until the next one starts, but no longer
 * than this (a slow speaker's longest words, plus a little).
 */
const MAX_WORD_SEC = 1.2;
/** A word's onset can be reported a little after its sound begins. */
const WORD_LEAD_SEC = 0.15;

/**
 * The spans the transcript's words account for, merged. A music marker
 * accounts for everything up to the next word: VAD hears singing as speech.
 */
export function wordCoverage(segments: readonly LabeledSegment[]): Span[] {
  const words = segments
    .flatMap((s) => s.words)
    .sort((a, b) => a.start - b.start);
  const spans = words.map((word, i) => {
    const next = words[i + 1]?.start ?? Infinity;
    return {
      start: word.start - WORD_LEAD_SEC,
      end: isMusicMarker(word)
        ? next
        : Math.min(next, word.start + MAX_WORD_SEC),
    };
  });
  return mergeSpans(spans, 0);
}

/** `a` minus `b`. Both sorted and non-overlapping. */
export function subtract(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let j = 0;
  for (const span of a) {
    let start = span.start;
    while (j < b.length && b[j]!.end <= start) j++;
    let k = j;
    while (k < b.length && b[k]!.start < span.end) {
      if (b[k]!.start > start) out.push({ start, end: b[k]!.start });
      start = Math.max(start, b[k]!.end);
      k++;
    }
    if (start < span.end) out.push({ start, end: span.end });
  }
  return out;
}

/** Sort and join spans whose gap is at most `maxGap`. */
export function mergeSpans(spans: readonly Span[], maxGap: number): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start - last.end <= maxGap) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export interface UntranscribedSpeech extends Span {
  /** Seconds of detected speech inside the span with no word on it. */
  speechSecs: number;
}

/**
 * Stretches where VAD hears speech but the transcript has no words: a turn
 * the recognizer skipped, or one cut out of a golden by mistake. Uncovered
 * speech separated by less than `joinSecs` is reported as one stretch, and
 * stretches with less than `minSpeechSecs` of speech are dropped (a cough,
 * a filler "um" that cleaning removed).
 */
export function untranscribedSpeech(
  runs: readonly Span[],
  segments: readonly LabeledSegment[],
  { minSpeechSecs = 2, joinSecs = 1.5 } = {},
): UntranscribedSpeech[] {
  const uncovered = subtract(runs, wordCoverage(segments));
  const groups: Span[][] = [];
  for (const span of uncovered) {
    const group = groups.at(-1);
    if (group && span.start - group.at(-1)!.end <= joinSecs) group.push(span);
    else groups.push([span]);
  }
  return groups
    .map((g) => ({
      start: round(g[0]!.start),
      end: round(g.at(-1)!.end),
      speechSecs: round(totalSecs(g)),
    }))
    .filter((g) => g.speechSecs >= minSpeechSecs);
}

/** Seconds to two decimals, so JSON stays readable. */
export const round = (secs: number) => Math.round(secs * 100) / 100;
