// Edits to a transcript that a person or an agent makes by hand: move a turn
// boundary, relabel a speaker, fix a misheard word, add a missed one. Each op
// addresses a word by its onset, as `formatClock` prints it, so an edit can be
// written from a rendered transcript and re-run. Generic over how a segment
// names its person: a slug in the golden transcripts, a `people.id` in the
// database.

import { formatClock } from "./clock";
import type { Segment, Speaker, Word } from "./transcript";

/** One edit. Onsets (`at`) are in seconds and match to the hundredth. */
export type EditOp<Person> =
  | {
      /**
       * The word at `at` (and equal to `word`, if given) starts a new segment
       * spoken by `speaker`, running to the next segment. If it already starts
       * a segment, that whole segment is relabelled.
       */
      op: "split";
      at: number;
      word?: string;
      speaker: Speaker<Person>;
    }
  | {
      /** Relabel the whole segment containing the word at `at`. */
      op: "label";
      at: number;
      word?: string;
      speaker: Speaker<Person>;
    }
  | {
      /**
       * Replace the words starting at `at`, which must read `old` (space
       * separated), with `new`, which may have more or fewer words; "" deletes.
       */
      op: "replace";
      at: number;
      old: string;
      new: string;
    }
  | {
      /**
       * Add words the transcript is missing, each at its onset. With
       * `speaker`, they are their own turn and the words after them go back
       * to whoever was speaking; without, they join the segment they fall in.
       */
      op: "insert";
      words: Word[];
      speaker?: Speaker<Person>;
    }
  | {
      /**
       * Replace every occurrence of `old`, ignoring case and trailing
       * punctuation, keeping the last old word's trailing punctuation.
       */
      op: "replace_all";
      old: string;
      new: string;
    };

/** An op that can't be applied, with which one (1-based) it was. */
export class EditError extends Error {
  constructor(
    readonly opNumber: number,
    message: string,
  ) {
    super(`op ${opNumber}: ${message}`);
  }
}

/** What applying edits did: the new segments, and a line per replace_all. */
export interface Edited<Person> {
  segments: Segment<Person>[];
  notes: string[];
}

/**
 * Apply `ops` in order, then drop wordless segments and merge neighbouring
 * segments with the same speaker. A segment's speaker is exactly what its
 * label op says: a person and no speaker number, or the reverse. Throws an
 * {@link EditError} on the first op that doesn't apply.
 */
export function applyEdits<Person>(
  segments: readonly Segment<Person>[],
  ops: readonly EditOp<Person>[],
): Edited<Person> {
  let segs = segments.map((s) => ({ ...s, words: [...s.words] }));
  const notes: string[] = [];
  ops.forEach((op, i) => {
    const fail = (message: string): never => {
      throw new EditError(i + 1, message);
    };
    switch (op.op) {
      case "split": {
        const [si, wi] = find(segs, op.at, op.word, fail);
        const seg = segs[si]!;
        if (wi === 0) {
          segs[si] = { ...seg, ...speakerOf(op.speaker) };
        } else {
          segs.splice(si + 1, 0, {
            ...seg,
            ...speakerOf(op.speaker),
            words: seg.words.slice(wi),
          });
          segs[si] = { ...seg, words: seg.words.slice(0, wi) };
        }
        break;
      }
      case "label": {
        const [si] = find(segs, op.at, op.word, fail);
        segs[si] = { ...segs[si]!, ...speakerOf(op.speaker) };
        break;
      }
      case "replace": {
        const [si, wi] = find(segs, op.at, undefined, fail);
        const old = splitWords(op.old);
        if (!old.length) fail("replace needs the words it replaces");
        const words = segs[si]!.words;
        const got = words.slice(wi, wi + old.length).map((w) => w.text);
        if (got.join(" ") !== old.join(" "))
          fail(
            `expected ${JSON.stringify(old.join(" "))} at ${formatClock(op.at)}, found ${JSON.stringify(got.join(" "))}`,
          );
        splice(words, wi, old.length, splitWords(op.new));
        break;
      }
      case "insert": {
        type Flat = { word: Word; speaker: Speaker<Person> };
        const flat: Flat[] = segs.flatMap((s) =>
          s.words.map((word) => ({ word, speaker: speakerOf(s) })),
        );
        const taken = new Set(flat.map((f) => cs(f.word.start)));
        for (const word of op.words) {
          if (!word.text.trim() || /\s/.test(word.text.trim()))
            fail(`can't insert ${JSON.stringify(word.text)}: not one word`);
          if (taken.has(cs(word.start)))
            fail(
              `can't insert ${JSON.stringify(word.text)}: a word already starts at ${formatClock(word.start)}`,
            );
          taken.add(cs(word.start));
          const before = flat.filter((f) => f.word.start < word.start).at(-1);
          const speaker =
            op.speaker ?? before?.speaker ?? flat[0]?.speaker ?? unlabeled();
          flat.push({
            word: { text: word.text.trim(), start: word.start },
            speaker: speakerOf(speaker),
          });
        }
        flat.sort((a, b) => a.word.start - b.word.start);
        segs = [];
        for (const { word, speaker } of flat) {
          const last = segs.at(-1);
          if (last && sameSpeaker(last, speaker)) last.words.push(word);
          else segs.push({ ...speaker, words: [word] });
        }
        break;
      }
      case "replace_all": {
        const old = splitWords(op.old).map(norm);
        if (!old.length) fail("replace_all needs words to replace");
        const repl = splitWords(op.new);
        let count = 0;
        for (const seg of segs) {
          const words = seg.words;
          let k = 0;
          while (k <= words.length - old.length) {
            const here = words
              .slice(k, k + old.length)
              .map((w) => norm(w.text));
            if (here.join(" ") !== old.join(" ")) {
              k++;
              continue;
            }
            const texts = [...repl];
            const punct = trail(words[k + old.length - 1]!.text);
            if (texts.length && !trail(texts.at(-1)!))
              texts[texts.length - 1] += punct;
            splice(words, k, old.length, texts);
            count++;
            k += texts.length;
          }
        }
        notes.push(
          `replace_all ${JSON.stringify(op.old)} -> ${JSON.stringify(op.new)}: ${count}`,
        );
        break;
      }
    }
  });
  const merged: Segment<Person>[] = [];
  for (const seg of segs) {
    if (!seg.words.length) continue;
    const last = merged.at(-1);
    if (last && sameSpeaker(last, seg)) last.words.push(...seg.words);
    else merged.push(seg);
  }
  return { segments: merged, notes };
}

/** Whether two segments name the same speaker, field for field. */
export function sameSpeaker<Person>(
  a: Speaker<Person>,
  b: Speaker<Person>,
): boolean {
  return a.person === b.person && a.speakerNumber === b.speakerNumber;
}

function speakerOf<Person>(s: Speaker<Person>): Speaker<Person> {
  return { speakerNumber: s.speakerNumber, person: s.person };
}

function unlabeled<Person>(): Speaker<Person> {
  return { speakerNumber: null, person: null };
}

/** Seconds as whole hundredths, the precision onsets are addressed at. */
function cs(secs: number): number {
  return Math.round(secs * 100);
}

/** [segment index, word index] of the word at `at`, matching `word` if given. */
function find<Person>(
  segs: readonly Segment<Person>[],
  at: number,
  word: string | undefined,
  fail: (message: string) => never,
): [number, number] {
  const near: string[] = [];
  for (let si = 0; si < segs.length; si++) {
    const words = segs[si]!.words;
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi]!;
      if (cs(w.start) === cs(at) && (word === undefined || w.text === word))
        return [si, wi];
      if (Math.abs(w.start - at) < 3 && near.length < 12)
        near.push(`${formatClock(w.start)}=${w.text}`);
    }
  }
  return fail(
    `no word${word === undefined ? "" : ` ${JSON.stringify(word)}`} at ${formatClock(at)}; nearby: ${near.join(" ")}`,
  );
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Replace `n` words at `i` with `texts`. Each new word takes the onset of the
 * old word in its position, or the last old word's when there are more.
 */
function splice(words: Word[], i: number, n: number, texts: string[]): void {
  const times = words.slice(i, i + n).map((w) => w.start);
  const added = texts.map((text, k) => ({
    text,
    start: times[Math.min(k, times.length - 1)]!,
  }));
  words.splice(i, n, ...added);
}

const TRAILING_PUNCT = /[.,?!;:"']+$/;

function norm(w: string): string {
  return w.replace(TRAILING_PUNCT, "").toLowerCase();
}

function trail(w: string): string {
  return TRAILING_PUNCT.exec(w)?.[0] ?? "";
}
