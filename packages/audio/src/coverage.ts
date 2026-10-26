import type { Word } from "@open-minutes/core/transcript";
import {
  mergeSpans,
  type Span,
  subtract,
  totalSecs,
} from "@open-minutes/core/span";

// How much of the detected speech (from `detectSpeech`) a transcript's words
// account for, and where the speech no word covers is.

/**
 * How long one word is assumed to cover after its onset, at most. Words
 * carry only onsets; a word runs until the next one starts, but no longer
 * than this (a slow speaker's longest words, plus a little).
 */
const MAX_WORD_SEC = 1.2;
/** A word's onset can be reported a little after its sound begins. */
const WORD_LEAD_SEC = 0.15;

/**
 * The spans `words` account for, sorted and disjoint. The words needn't be
 * in time order.
 */
export function wordCoverage(words: readonly Word[]): Span[] {
  const onsets = words.map((w) => w.start).sort((a, b) => a - b);
  const spans = onsets.map((start, i) => ({
    start: start - WORD_LEAD_SEC,
    end: Math.min(onsets[i + 1] ?? Infinity, start + MAX_WORD_SEC),
  }));
  return mergeSpans(spans, 0);
}

export interface UntranscribedSpeech extends Span {
  /** Seconds of detected speech inside the span with no word on it. */
  speechSecs: number;
}

/**
 * Stretches where VAD hears speech but `words` has none: a turn
 * the recognizer skipped, or one cut out of a golden by mistake. Uncovered
 * speech separated by less than `joinSecs` is reported as one stretch, and
 * stretches with less than `minSpeechSecs` of speech are dropped (a cough,
 * a filler "um" that cleaning removed). `runs` must be sorted and disjoint,
 * as `detectSpeech` returns them; `words` can be in any order.
 */
export function untranscribedSpeech(
  runs: readonly Span[],
  words: readonly Word[],
  { minSpeechSecs = 2, joinSecs = 1.5 } = {},
): UntranscribedSpeech[] {
  const uncovered = subtract(runs, wordCoverage(words));
  const groups: Span[][] = [];
  for (const span of uncovered) {
    const group = groups.at(-1);
    if (group && span.start - group.at(-1)!.end <= joinSecs) group.push(span);
    else groups.push([span]);
  }
  return groups
    .map((g) => ({
      start: g[0]!.start,
      end: g.at(-1)!.end,
      speechSecs: totalSecs(g),
    }))
    .filter((g) => g.speechSecs >= minSpeechSecs);
}
