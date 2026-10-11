// Short answers left in the asker's turn. Diarization often folds a one-word
// reply into the segment of whoever asked for it: a roll call ("Member
// Johnson. Yes."), a vote put to the youth member, "Do we have a second?
// Second." The reply is someone else's voice, so it belongs in its own
// segment under whoever was asked.

import type { TranscriptWord } from "./types";

/** A whole sentence that answers a roll call, a question or a call for a motion. */
const ANSWER =
  /^(yes|yeah|yep|no|nope|aye|nay|here|present|second|seconded|i second|i'll second|so moved|moved)[.!]$/i;

/** An answer that makes or seconds a motion. */
const MOTION_ANSWER =
  /^(second|seconded|i second|i'll second|so moved|moved)[.!]$/i;

/** The chair restating a motion: "moved by …", "seconded by …". */
const RESTATES_MOTION = /\b(moved|seconded|second|motion)\b.*\bby\b/i;

/** A call for a second or a motion: "Do we have a second?", "a motion." */
const CALLS_FOR_MOTION = /\b(second|motion|move)\b/i;

/**
 * A roll call: a name after a title, or a first and last name: "Member
 * Johnson.", "Kellie Okonek?", "Youth Representative Bowser."
 */
const ROLL_CALL =
  /^(?:(?:Member|Mr\.|Ms\.|Mrs\.|Dr\.|Chair|Vice Chair|Co-chair|Youth Representative|Commissioner|Supervisor)\s+\p{Lu}[\p{L}'-]*|\p{Lu}[\p{L}'-]*(?:\s\p{Lu}[\p{L}'-]*){1,2})[.?]$/u;

/** A vote put to a member: "and the youth member votes." */
const PUTS_VOTE = /\bmember votes?[.?]$/i;

export interface FoldedAnswer {
  /** Index into the words of the answer's first word. */
  index: number;
  /** The answer, eg "Yes." */
  answer: string;
  /** The sentence that asked for it, or that restates the motion after it. */
  asked: string;
}

/** Sentences as [first word index, text]. */
function sentences(words: readonly TranscriptWord[]): [number, string][] {
  const out: [number, string][] = [];
  let start = 0;
  words.forEach((w, i) => {
    if (/[.?!]["')\]]*$/.test(w.text) || i === words.length - 1) {
      out.push([
        start,
        words
          .slice(start, i + 1)
          .map((x) => x.text)
          .join(" "),
      ]);
      start = i + 1;
    }
  });
  return out;
}

/**
 * Answers in one segment's words that follow, in the same segment, a
 * question, a roll-call name, a vote put to someone, or (for "Second." and
 * "So moved.") a call for a motion; and a "Second." or "So moved." that
 * opens a segment whose next sentence restates the motion.
 */
export function foldedAnswers(
  words: readonly TranscriptWord[],
): FoldedAnswer[] {
  const found: FoldedAnswer[] = [];
  const sents = sentences(words);
  // "Second. Moved by Ms. Brawley, seconded by Mr. Volland.": whoever
  // restates the motion didn't second it.
  const [first, next] = [sents[0], sents[1]];
  if (
    first &&
    next &&
    MOTION_ANSWER.test(first[1]) &&
    RESTATES_MOTION.test(next[1])
  )
    found.push({ index: first[0], answer: first[1], asked: next[1] });
  for (let k = 1; k < sents.length; k++) {
    const [index, answer] = sents[k]!;
    const asked = sents[k - 1]![1];
    if (!ANSWER.test(answer)) continue;
    const motion = MOTION_ANSWER.test(answer);
    // "…, right? Yeah." is usually the speaker answering their own tag.
    const tag = /\bright\?$/i.test(asked);
    if (
      (asked.endsWith("?") && !tag) ||
      ROLL_CALL.test(asked) ||
      PUTS_VOTE.test(asked) ||
      (motion && CALLS_FOR_MOTION.test(asked))
    )
      found.push({ index, answer, asked });
  }
  return found;
}
