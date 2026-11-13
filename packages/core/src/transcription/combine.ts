// Lining up several transcriptions of the same audio, word by word, so they
// can be voted on (ROVER: Fiscus, "A post-processing system to yield reduced
// word error rates", 1997).

import type { Word } from "../transcript";
import { normalizeToken } from "./wer";

/**
 * Seconds of onset difference that cost as much as one edit when lining up
 * words. Breaks ties between alignments with the same edits in favor of the
 * one that pairs words heard at the same time, eg which of two "yes"es a
 * third pass's "yes" goes with.
 */
const SECS_PER_EDIT = 10;

/**
 * Line up several transcriptions of the same audio. Each slot holds, for
 * each hypothesis, the word it heard there, or null where it heard nothing.
 * A word joins a slot whose other words it equals (ignoring case and
 * punctuation), or one where it differs (a substitution), or starts a slot of
 * its own; the alignment minimizes these edits, and then the difference in
 * onsets. Every word of every hypothesis is in exactly one slot, and each
 * hypothesis's words stay in order.
 *
 * Hypotheses are added one at a time, each aligned against the slots built so
 * far, so words that two hypotheses heard and the first didn't still share a
 * slot.
 */
export function alignHypotheses<W extends Word>(
  hypotheses: readonly (readonly W[])[],
): (W | null)[][] {
  const k = hypotheses.length;
  let slots: Slot<W>[] = [];
  hypotheses.forEach((hyp, h) => {
    slots = addHypothesis(slots, hyp, h, k);
  });
  return slots.map((s) => s.words);
}

interface Slot<W extends Word> {
  words: (W | null)[];
  /** Normalized tokens of the slot's words. */
  tokens: Set<string>;
  /** Mean onset of the slot's words. */
  start: number;
}

function addHypothesis<W extends Word>(
  slots: readonly Slot<W>[],
  hyp: readonly W[],
  h: number,
  k: number,
): Slot<W>[] {
  const m = slots.length;
  const n = hyp.length;
  const tokens = hyp.map((w) => normalizeToken(w.text));
  const width = n + 1;
  const cost = new Float64Array((m + 1) * width);
  // 0: pair slot i-1 with word j-1; 1: slot i-1 gets no word; 2: word j-1 gets a new slot.
  const back = new Uint8Array((m + 1) * width);
  for (let j = 1; j <= n; j++) {
    cost[j] = j;
    back[j] = 2;
  }
  for (let i = 1; i <= m; i++) {
    cost[i * width] = i;
    back[i * width] = 1;
    const slot = slots[i - 1]!;
    for (let j = 1; j <= n; j++) {
      const word = hyp[j - 1]!;
      const pair =
        cost[(i - 1) * width + j - 1]! +
        (slot.tokens.has(tokens[j - 1]!) ? 0 : 1) +
        Math.abs(slot.start - word.start) / SECS_PER_EDIT;
      const skip = cost[(i - 1) * width + j]! + 1;
      const insert = cost[i * width + j - 1]! + 1;
      let best = pair;
      let op = 0;
      if (skip < best) {
        best = skip;
        op = 1;
      }
      if (insert < best) {
        best = insert;
        op = 2;
      }
      cost[i * width + j] = best;
      back[i * width + j] = op;
    }
  }

  const out: Slot<W>[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const op = back[i * width + j];
    if (op === 0) {
      out.push(withWord(slots[i - 1]!, hyp[j - 1]!, tokens[j - 1]!, h));
      i--;
      j--;
    } else if (op === 1) {
      out.push(slots[i - 1]!);
      i--;
    } else {
      const words = new Array<W | null>(k).fill(null);
      words[h] = hyp[j - 1]!;
      out.push({
        words,
        tokens: new Set([tokens[j - 1]!]),
        start: hyp[j - 1]!.start,
      });
      j--;
    }
  }
  return out.reverse();
}

function withWord<W extends Word>(
  slot: Slot<W>,
  word: W,
  token: string,
  h: number,
): Slot<W> {
  const words = [...slot.words];
  words[h] = word;
  const heard = words.filter((w) => w !== null);
  return {
    words,
    tokens: new Set([...slot.tokens, token]),
    start: heard.reduce((s, w) => s + w.start, 0) / heard.length,
  };
}
