// Helpers for the rules that drop disfluent words from a transcript:
// filler-word, false-start and stutter. Each finds the words to drop in a
// segment, from which its rule reports them and its fix drops them,
// repairing the text around the gap.

import type { TranscriptWord } from "../transcription";
import type { AtWord, Fixed, RuleMeeting, Violation } from "./common";

/** Splits a word into leading punctuation, its letters/digits, and trailing punctuation. */
const WORD_PARTS = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u;
const SENTENCE_END = /[.?!]/;

/** A word's letters and digits, without the punctuation around them. */
export function wordCore(text: string): string {
  return WORD_PARTS.exec(text)![2]!;
}

export function trailingPunctuation(text: string): string {
  return WORD_PARTS.exec(text)![3]!;
}

function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.at(-1) ?? "");
}

function capitalizeFirst(text: string): string {
  return text.replace(/\p{L}/u, (c) => c.toUpperCase());
}

function startsUppercase(text: string): boolean {
  return /^\P{L}*\p{Lu}/u.test(text);
}

/** Give `text` a sentence-ending mark, replacing any trailing , ; : or dash. */
function endSentence(text: string, mark: string): string {
  if (endsSentence(text)) return text;
  return text.replace(/[,;:\-–—]+$/u, "") + mark;
}

/**
 * Which of a segment's words to drop, by index. Sees the words as they are,
 * so a rule may look at the word after.
 */
export type FindDrops = (words: readonly TranscriptWord[]) => boolean[];

/** A word to drop, as a violation of a dropping rule. */
export type DroppedWord<Code extends string> = Violation<Code> &
  AtWord & {
    text: string;
  };

/** A rule's violations: each word `findDrops` would drop. */
export function droppedWords<Code extends string>(
  meeting: RuleMeeting,
  code: Code,
  findDrops: FindDrops,
  describe: (text: string) => string,
): DroppedWord<Code>[] {
  return meeting.segments.flatMap(({ words }, segmentIndex) => {
    const drops = findDrops(words);
    return words.flatMap((w, wordIndex) =>
      drops[wordIndex]
        ? [
            {
              code,
              message: `${describe(w.text)} should not be in a transcript`,
              segmentIndex,
              wordIndex,
              atSecs: w.start,
              text: w.text,
            },
          ]
        : [],
    );
  });
}

/** A rule's fix: drop each word `findDrops` would drop. */
export function dropWords<M extends RuleMeeting, V extends Violation>(
  meeting: M,
  violations: readonly V[],
  findDrops: FindDrops,
): Fixed<M, V> {
  if (violations.length === 0) return { meeting, fixed: [] };
  return {
    meeting: {
      ...meeting,
      segments: meeting.segments.map((seg) => {
        const drops = findDrops(seg.words);
        return drops.some(Boolean)
          ? { ...seg, words: dropAndRepair(seg.words, drops) }
          : seg;
      }),
    },
    fixed: [...violations],
  };
}

/**
 * The words without those marked to drop, repairing the text around each
 * gap so it still reads as sentences:
 *
 *   - A sentence-ending mark on a dropped word moves to the previous kept word
 *     ("making um." → "making."), replacing a trailing comma there.
 *   - A dropped sentence-initial word hands its capital to the next kept word
 *     ("Um, so we" → "So we", "And and" → "And").
 *   - Commas and other marks on a dropped word go with it.
 *
 * Kept words keep their onsets and any other properties.
 */
function dropAndRepair<W extends TranscriptWord>(
  words: readonly W[],
  drops: readonly boolean[],
): W[] {
  const out: W[] = [];
  let capitalizeNext = false;
  words.forEach((word, i) => {
    if (!drops[i]) {
      out.push(
        capitalizeNext && !startsUppercase(word.text)
          ? { ...word, text: capitalizeFirst(word.text) }
          : word,
      );
      capitalizeNext = false;
      return;
    }
    const prev = out.at(-1);
    if (startsUppercase(word.text) && (!prev || endsSentence(prev.text)))
      capitalizeNext = true;
    const mark = SENTENCE_END.exec(trailingPunctuation(word.text))?.[0];
    if (mark && prev)
      out[out.length - 1] = { ...prev, text: endSentence(prev.text, mark) };
  });
  return out;
}
