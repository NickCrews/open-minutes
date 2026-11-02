import type { AtWord, RuleMeeting, Severity, Violation } from "./common";
import * as stutter from "./stutter";
import { trailingPunctuation, wordCore } from "./words";

export const code = "repeated-word";

export type RepeatedWord = Violation<typeof code> &
  AtWord & {
    /** The repeated words, eg "what what". */
    text: string;
  };

export const defaultSeverity = "warning" satisfies Severity;

// Words that are often correctly said twice in a row: "what it is is",
// "logged in in time", "told you you'd", "my great great grandfather", "for
// many many years", replies ("yes yes", "no no"), and spelled numbers
// ("twenty twenty", "nine one one").
const ALLOWED = new Set([
  "are",
  "bye",
  "do",
  "great",
  "had",
  "her",
  "in",
  "is",
  "many",
  "much",
  "no",
  "okay",
  "on",
  "really",
  "that",
  "very",
  "was",
  "were",
  "yeah",
  "yep",
  "yes",
  "you",
  "zero",
  "oh",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
]);

interface Placed {
  segmentIndex: number;
  wordIndex: number;
  start: number;
  text: string;
  core: string;
}

/**
 * Whether `word` then `next` is a repeat worth a look. Punctuation after the
 * first copy marks a deliberate repeat ("very, very good", "Yes. Yes."), and
 * single letters are spelling ("N N E").
 */
function repeats(word: Placed, next: Placed): boolean {
  return (
    word.core !== "" &&
    word.core === next.core &&
    trailingPunctuation(word.text) === "" &&
    (word.core.length > 1 || word.core === "a" || word.core === "i") &&
    !ALLOWED.has(word.core)
  );
}

/**
 * A word said twice in a row ("elaborate elaborate"), likely a stutter, even
 * across segments. Each run of copies is reported once, at its first word.
 * Leaves out what the stutter rule finds.
 */
export function rule(meeting: RuleMeeting): RepeatedWord[] {
  const words: Placed[] = meeting.segments.flatMap((seg, segmentIndex) =>
    seg.words.map((w, wordIndex) => ({
      segmentIndex,
      wordIndex,
      start: w.start,
      text: w.text,
      core: wordCore(w.text).toLowerCase(),
    })),
  );
  const stuttered = new Set(
    stutter.rule(meeting).map((v) => `${v.segmentIndex}:${v.wordIndex}`),
  );
  const found: RepeatedWord[] = [];
  let run: Placed[] = [];
  const report = () => {
    if (run.length > 1) {
      const text = run.map((w) => w.text).join(" ");
      found.push({
        code,
        message: `${JSON.stringify(text)}: a word said twice in a row is usually a stutter; drop the extra copy unless it was meant`,
        segmentIndex: run[0]!.segmentIndex,
        wordIndex: run[0]!.wordIndex,
        atSecs: run[0]!.start,
        text,
      });
    }
    run = [];
  };
  words.forEach((word, i) => {
    const next = words[i + 1];
    if (
      next &&
      repeats(word, next) &&
      !stuttered.has(`${word.segmentIndex}:${word.wordIndex}`)
    ) {
      if (run.length === 0) run.push(word);
      run.push(next);
    } else {
      report();
    }
  });
  report();
  return found;
}
