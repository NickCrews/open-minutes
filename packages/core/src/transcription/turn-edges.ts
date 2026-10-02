// Speaker changes that land inside a sentence. Diarization and recognition
// cut the audio separately, so a speaker boundary often sits a word or two
// off the real turn change: "Pledge of Allegiance? I | pledge allegiance…"
// or "Thank | you." A boundary inside a sentence is suspect, and it is very
// likely misplaced when a clearly longer pause sits at that sentence's edge
// a few words away.

import type { TranscriptWord } from "./types";

/** How far, in words, a boundary may be from the sentence edge it belongs at. */
const MAX_WORDS_OFF = 3;
/** A pause at least this long at the boundary is a plausible turn change. */
const PLAUSIBLE_PAUSE_SEC = 1;
/** The pause at the sentence edge must be this many times longer… */
const PAUSE_RATIO = 2;
/** …and at least this much longer, in seconds. */
const MIN_PAUSE_DIFF_SEC = 0.3;

const SENTENCE_END = /[.?!]["')\]]*$/;
const QUESTION_END = /\?["')\]]*$/;
/** A capitalized word other than "I": recognition started a sentence there. */
const STARTS_SENTENCE = /^(?!I(?:'|\b))["'(]?\p{Lu}/u;

export interface SplitSentence {
  /** Index of the segment that starts at the suspect boundary. */
  segment: number;
  /** Onset of the first word after the boundary. */
  start: number;
  /** Seconds between the onsets either side of the boundary. */
  pause: number;
  /** Onset of the word after the longer pause, where the turn probably changes. */
  edgeStart: number;
  /** Seconds between the onsets either side of that pause. */
  edgePause: number;
  /** The words between the boundary and that pause, which probably belong to the other speaker. */
  misplaced: TranscriptWord[];
}

/**
 * Find speaker boundaries that fall inside a sentence, a few words from a
 * sentence edge with a clearly longer pause. Each segment is one speaker's
 * turn; pass only boundaries between different speakers (merge same-speaker
 * neighbours first, or skip what comes back for them).
 *
 * Onsets stand in for pauses, since words carry no end times, so a long
 * word reads as a short pause after it. Some boundaries are accepted as
 * they are: one already at a pause of a second or more, and one before a
 * capitalized word, where recognition heard a new sentence begin (as when
 * someone is cut off mid-sentence). A question is never moved across a
 * boundary: the pause after one is the asker waiting for an answer.
 */
export function splitSentences(
  segments: readonly { words: readonly TranscriptWord[] }[],
): SplitSentence[] {
  const found: SplitSentence[] = [];
  for (let s = 1; s < segments.length; s++) {
    const before = segments[s - 1]!.words;
    const after = segments[s]!.words;
    if (before.length === 0 || after.length === 0) continue;
    if (SENTENCE_END.test(before.at(-1)!.text)) continue;

    if (STARTS_SENTENCE.test(after[0]!.text)) continue;

    const words = [...before, ...after];
    const b = before.length;
    const pause = (i: number) => words[i]!.start - words[i - 1]!.start;
    if (pause(b) >= PLAUSIBLE_PAUSE_SEC) continue;

    // Candidate edges: the start of the sentence the boundary splits, if it
    // began in `before`, and its end, if it ends in `after`.
    const edges: number[] = [];
    for (let i = b - 1; i >= Math.max(1, b - MAX_WORDS_OFF); i--) {
      if (SENTENCE_END.test(words[i - 1]!.text)) {
        edges.push(i);
        break;
      }
    }
    for (
      let i = b + 1;
      i <= Math.min(words.length - 1, b + MAX_WORDS_OFF);
      i++
    ) {
      const last = words[i - 1]!.text;
      if (SENTENCE_END.test(last)) {
        if (!QUESTION_END.test(last)) edges.push(i);
        break;
      }
    }
    const edge = edges.reduce<number | undefined>(
      (best, i) => (best === undefined || pause(i) > pause(best) ? i : best),
      undefined,
    );
    if (edge === undefined) continue;
    if (
      pause(edge) < PAUSE_RATIO * pause(b) ||
      pause(edge) - pause(b) < MIN_PAUSE_DIFF_SEC
    )
      continue;
    found.push({
      segment: s,
      start: words[b]!.start,
      pause: round(pause(b)),
      edgeStart: words[edge]!.start,
      edgePause: round(pause(edge)),
      misplaced: edge < b ? words.slice(edge, b) : words.slice(b, edge),
    });
  }
  return found;
}

function round(secs: number): number {
  return Math.round(secs * 100) / 100;
}
