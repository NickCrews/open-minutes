// Transcript cleaning: rewrites applied to raw recognizer output before it is
// aligned, stored or used as a golden. The recognizer transcribes verbatim, so
// its output is full of disfluencies — hesitations ("um"), stutters ("the the"),
// abandoned word fragments ("six- sixteen") — that make a transcript harder to
// read without adding anything a reader of meeting minutes needs.
//
// Cleaning is a list of independent RULES, each a pure pass over one speaker's
// (or one speech run's) words that returns the rewritten words plus a record of
// every change it made. Checking is defined as "cleaning would change nothing",
// so the cleaner and the checker can never disagree. To add a cleanup, write a
// rule and append it to CLEANING_RULES; the pipeline (transcribe → clean) and
// the golden tooling (`pnpm fixtures clean|check`) pick it up automatically.
//
// Rules are deliberately conservative: a missed disfluency costs a little
// readability, but deleting a word someone actually meant changes the record.

import { plainDashes } from "../text";
import type { SpeechSegment, TranscriptWord } from "./types";

/** One edit a cleaning rule made, reported against the word it touched. */
export interface CleanChange {
  /** Name of the rule that made the change, eg "filler". */
  rule: string;
  /** Onset of the affected word, in seconds. */
  start: number;
  /** The affected word's text before cleaning. */
  before: string;
  /** Its text after cleaning, or null if the word was removed. */
  after: string | null;
}

export interface CleanResult<W extends TranscriptWord> {
  words: W[];
  changes: CleanChange[];
}

export interface CleaningRule {
  name: string;
  /** What the rule removes, for help text and docs. */
  description: string;
  apply<W extends TranscriptWord>(words: readonly W[]): CleanResult<W>;
}

// ---------------------------------------------------------------------------
// Word-shape helpers

/** Splits a word into leading punctuation, its letters/digits, and trailing punctuation. */
const WORD_PARTS = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u;
const SENTENCE_END = /[.?!]/;

function wordCore(text: string): string {
  return WORD_PARTS.exec(text)![2]!;
}

function trailingPunctuation(text: string): string {
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
 * Shared machinery for rules that drop words. `shouldDrop` sees each word with
 * the next word in the ORIGINAL stream. Dropping repairs the text around the
 * gap so it still reads as sentences:
 *
 *   - A sentence-ending mark on a dropped word moves to the previous kept word
 *     ("making um." → "making."), replacing a trailing comma there.
 *   - A dropped sentence-initial word hands its capital to the next kept word
 *     ("Um, so we" → "So we", "And and" → "And").
 *   - Commas and other marks on a dropped word go with it.
 */
function dropWords<W extends TranscriptWord>(
  rule: string,
  words: readonly W[],
  shouldDrop: (word: W, next: W | undefined) => boolean,
): CleanResult<W> {
  const out: W[] = [];
  const changes: CleanChange[] = [];
  const record = (word: W, after: string | null) =>
    changes.push({ rule, start: word.start, before: word.text, after });
  let capitalizeNext = false;

  words.forEach((word, i) => {
    if (!shouldDrop(word, words[i + 1])) {
      if (capitalizeNext && !startsUppercase(word.text)) {
        const text = capitalizeFirst(word.text);
        record(word, text);
        out.push({ ...word, text });
      } else {
        out.push(word);
      }
      capitalizeNext = false;
      return;
    }
    record(word, null);
    const prev = out.at(-1);
    if (startsUppercase(word.text) && (!prev || endsSentence(prev.text))) {
      capitalizeNext = true;
    }
    const mark = SENTENCE_END.exec(trailingPunctuation(word.text))?.[0];
    if (mark && prev) {
      const text = endSentence(prev.text, mark);
      if (text !== prev.text) {
        record(prev, text);
        out[out.length - 1] = { ...prev, text };
      }
    }
  });
  return { words: out, changes };
}

// ---------------------------------------------------------------------------
// Rules

// Hesitation sounds with no lexical content, matched case-insensitively against
// the word stripped of punctuation. Deliberately narrow: "oh", "ah", "hmm" and
// "mm-hmm" often carry meaning ("Oh, I see"; "Mm-hmm" for yes), and "uh-huh" /
// "uh-oh" survive because the hyphen keeps them from matching.
const FILLER_PATTERN = /^(?:u+[hm]+|e+r+m+)$/i;

/** Whether `text` (one recognized word, punctuation included) is a filler word. */
export function isFillerWord(text: string): boolean {
  return FILLER_PATTERN.test(wordCore(text));
}

export const fillerRule: CleaningRule = {
  name: "filler",
  description: 'hesitation sounds ("um", "uh", "erm")',
  apply: (words) =>
    dropWords("filler", words, (word) => isFillerWord(word.text)),
};

// A word the speaker broke off and then restarted in full: the recognizer
// writes the fragment with a trailing hyphen ("six- sixteen", "re- reconsider").
// Only when the next word completes the fragment: a hyphen is also how the
// recognizer writes number separators ("twenty twenty six- twenty-three" is
// AO 2026-23) and suspended compounds ("pre- and post-war").
export const falseStartRule: CleaningRule = {
  name: "false-start",
  description: 'abandoned word fragments ("six- sixteen" → "sixteen")',
  apply: (words) =>
    dropWords("false-start", words, (word, next) => {
      if (!next || !/\p{L}-$/u.test(word.text)) return false;
      const fragment = wordCore(word.text).toLowerCase();
      const restart = wordCore(next.text).toLowerCase();
      return restart.length > fragment.length && restart.startsWith(fragment);
    }),
};

// Words that are never correctly said twice in a row, so a doubled one is a
// stutter ("I I think", "the the budget"). Words that CAN legitimately double
// are left out on purpose: "that that", "had had", "is is" / "was was" / "are
// are" ("what it is is..."), "in in" / "on on" ("logged in in time"), "you you"
// ("told you you'd"), and numbers ("twenty twenty").
const STUTTER_WORDS = new Set([
  "a",
  "an",
  "and",
  "but",
  "for",
  "he",
  "he's",
  "i",
  "i'll",
  "i'm",
  "i've",
  "if",
  "it",
  "it's",
  "my",
  "of",
  "or",
  "our",
  "she",
  "she's",
  "so",
  "the",
  "their",
  "there's",
  "they",
  "they're",
  "this",
  "to",
  "we",
  "we'll",
  "we're",
  "we've",
  "with",
  "your",
]);

// Of those, the ones whose stutter can carry a comma ("the, the budget"). Not
// "it" or "this" and friends: "when we approved it, it passed" is grammatical.
const STUTTER_WORDS_WITH_COMMA = new Set(["a", "an", "and", "i", "the", "of"]);

// A real stutter restarts at once; a repeat after a long pause is more likely
// a new phrase.
const STUTTER_MAX_GAP_SEC = 1.5;

export const stutterRule: CleaningRule = {
  name: "stutter",
  description: 'immediately repeated function words ("the the" → "the")',
  // Drops the FIRST copy, so the survivor keeps any punctuation the second
  // carried. A sentence end between the copies ("about it. It is") is not a
  // stutter, nor is most punctuation (see STUTTER_WORDS_WITH_COMMA).
  apply: (words) =>
    dropWords("stutter", words, (word, next) => {
      if (!next) return false;
      const core = wordCore(word.text).toLowerCase();
      const punct = trailingPunctuation(word.text);
      const punctOk =
        punct === "" || (punct === "," && STUTTER_WORDS_WITH_COMMA.has(core));
      return (
        punctOk &&
        STUTTER_WORDS.has(core) &&
        wordCore(next.text).toLowerCase() === core &&
        next.start - word.start <= STUTTER_MAX_GAP_SEC
      );
    }),
};

// Stored text uses a plain hyphen for every dash (see core/text.ts). The
// recognizer occasionally writes an en or em dash, eg in a number range.
export const dashRule: CleaningRule = {
  name: "dash",
  description: 'en and em dashes ("2019–2022" → "2019-2022")',
  apply: (words) => {
    const changes: CleanChange[] = [];
    const out = words.map((word) => {
      const text = plainDashes(word.text);
      if (text === word.text) return word;
      changes.push({
        rule: "dash",
        start: word.start,
        before: word.text,
        after: text,
      });
      return { ...word, text };
    });
    return { words: out, changes };
  },
};

/**
 * Every cleaning rule, in the order they run. Dashes go first so the other
 * rules only ever see plain hyphens ("six– sixteen" is a false start). Fillers
 * go before stutters so a stutter broken up by one ("the, um, the") is caught
 * once the filler is gone.
 */
export const CLEANING_RULES: readonly CleaningRule[] = [
  dashRule,
  fillerRule,
  falseStartRule,
  stutterRule,
];

// ---------------------------------------------------------------------------
// Entry points

/**
 * Run every cleaning rule over one continuous run of speech (one speaker's
 * segment, or one VAD run). Kept words keep their onsets and any extra
 * properties; only their text may change. The input is not mutated.
 */
export function cleanWords<W extends TranscriptWord>(
  words: readonly W[],
  rules: readonly CleaningRule[] = CLEANING_RULES,
): CleanResult<W> {
  let current: W[] = [...words];
  const changes: CleanChange[] = [];
  for (const rule of rules) {
    const result = rule.apply(current);
    current = result.words;
    changes.push(...result.changes);
  }
  changes.sort((a, b) => a.start - b.start);
  return { words: current, changes };
}

/**
 * Everything {@link cleanWords} would change in `words`. Empty means the words
 * are already clean.
 */
export function findUncleanWords(
  words: readonly TranscriptWord[],
  rules: readonly CleaningRule[] = CLEANING_RULES,
): CleanChange[] {
  return cleanWords(words, rules).changes;
}

/**
 * Clean each group (a speaker segment, a VAD run) separately — rules never
 * reach across a group boundary, since the next group may be a different
 * speaker ("Yes." / "Yes." on a roll call is not a stutter). Groups may come
 * back empty; callers decide whether to keep them.
 */
export function cleanGroups<G extends { words: TranscriptWord[] }>(
  groups: readonly G[],
  rules: readonly CleaningRule[] = CLEANING_RULES,
): { groups: G[]; changes: CleanChange[] } {
  const changes: CleanChange[] = [];
  const cleaned = groups.map((g) => {
    const result = cleanWords(g.words, rules);
    changes.push(...result.changes);
    return { ...g, words: result.words };
  });
  return { groups: cleaned, changes };
}

/**
 * The pipeline's clean stage: {@link cleanGroups} over transcribeAudio's
 * output. Keeps every VAD run, even one left empty, since run bounds still
 * mark where speech was.
 */
export function cleanSpeechSegments(
  segments: readonly SpeechSegment[],
): SpeechSegment[] {
  return cleanGroups(segments).groups;
}
