import type { TranscriptWord } from "@open-minutes/core/transcription";
import type { Span } from "./speech-runs.js";

// Parakeet sometimes emits nothing for seconds of plain speech, and a decode
// of just that stretch usually hears it (see parakeet.characterization.test.ts
// in @open-minutes/ingest). A hole is where to look for that: speech by VAD
// with no word onset for longer than a word lasts.

/** A gap between onsets longer than this, in speech, may be a hole. */
export const HOLE_GAP_SEC = 2;
/** The least speech, after the last word's plausible end, that makes a hole. */
export const HOLE_MIN_SEC = 1.2;

/**
 * How long a word plausibly lasts after its onset: at least a long word's
 * worth, and for a number written in digits (one token, read out as several
 * words, like "2026-0064") a few tenths of a second per digit.
 */
export function wordSecs(text: string): number {
  const digits = text.match(/\p{N}/gu)?.length ?? 0;
  return Math.max(0.6, digits * 0.4);
}

/**
 * The holes in `words` (in time order): stretches inside `speech` where the
 * onsets are more than HOLE_GAP_SEC apart and at least HOLE_MIN_SEC of speech
 * is left after the earlier word's plausible end.
 */
export function findHoles(
  words: readonly TranscriptWord[],
  speech: readonly Span[],
): Span[] {
  const holes: Span[] = [];
  let w = 0;
  for (const span of speech) {
    // A word can start a little before VAD hears its span begin.
    while (w < words.length && words[w]!.start < span.start - 0.3) w++;
    let at = span.start;
    let free = span.start;
    const consider = (next: number) => {
      if (next - at > HOLE_GAP_SEC && next - free >= HOLE_MIN_SEC)
        holes.push({ start: free, end: next });
    };
    for (; w < words.length && words[w]!.start < span.end; w++) {
      const word = words[w]!;
      if (word.start > span.start) {
        consider(word.start);
        at = word.start;
        free = word.start + wordSecs(word.text);
      } else free = Math.max(free, word.start + wordSecs(word.text));
    }
    consider(span.end);
  }
  return holes;
}

/**
 * `hole` cut into pieces of at most `maxSecs`, each cut at the widest pause
 * in `speech` within 2 s of where an even split would put it.
 */
export function splitHole(
  hole: Span,
  speech: readonly Span[],
  maxSecs: number,
): Span[] {
  const length = hole.end - hole.start;
  if (length <= maxSecs) return [hole];
  const n = Math.ceil(length / maxSecs);
  const cuts = [hole.start];
  for (let k = 1; k < n; k++) {
    const even = hole.start + (length * k) / n;
    let cut = even;
    let widest = 0;
    for (let i = 0; i + 1 < speech.length; i++) {
      const from = speech[i]!.end;
      const to = speech[i + 1]!.start;
      const mid = (from + to) / 2;
      if (Math.abs(mid - even) <= 2 && to - from > widest) {
        cut = mid;
        widest = to - from;
      }
    }
    cuts.push(cut);
  }
  cuts.push(hole.end);
  return cuts.slice(0, -1).map((start, i) => ({ start, end: cuts[i + 1]! }));
}
