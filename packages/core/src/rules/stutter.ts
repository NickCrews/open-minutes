import type { RuleMeeting, Severity } from "./common";
import {
  type DroppedWord,
  dropWords,
  droppedWords,
  type FindDrops,
  trailingPunctuation,
  wordCore,
} from "./words";

export const code = "stutter";

export type Stutter = DroppedWord<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

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

// The FIRST copy is the stutter, so the survivor keeps any punctuation the
// second carried. A sentence end between the copies ("about it. It is") is not
// a stutter, nor is most punctuation (see STUTTER_WORDS_WITH_COMMA).
const findDrops: FindDrops = (words) =>
  words.map((word, i) => {
    const next = words[i + 1];
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
  });

/** An immediately repeated function word ("the the"): the first copy. */
export function rule(meeting: RuleMeeting): Stutter[] {
  return droppedWords(
    meeting,
    code,
    findDrops,
    (t) => `stutter ${JSON.stringify(t)}`,
  );
}

/** Drops each stuttered copy, keeping the last. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly Stutter[],
) {
  return dropWords(meeting, violations, findDrops);
}
