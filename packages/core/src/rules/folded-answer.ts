// Short answers left in the asker's turn. Diarization often folds a one-word
// reply into the segment of whoever asked for it: a roll call ("Member
// Johnson. Yes."), a vote put to the youth member, "Do we have a second?
// Second." The reply is someone else's voice, so it belongs in its own
// segment under whoever was asked.

import type { Word } from "../transcript";
import type { AtWord, Fixed, RuleMeeting, Severity, Violation } from "./common";

/** A whole sentence that answers a roll call, a question or a call for a motion. */
const ANSWER =
  /^(yes|yeah|yep|no|nope|aye|nay|here|present|second|seconded|i second|i'll second|so moved|moved)[.!]$/i;

/** An answer that makes or seconds a motion. */
const MOTION_ANSWER =
  /^(second|seconded|i second|i'll second|so moved|moved)[.!]$/i;

/** The chair restating a motion: "moved by …", "seconded by …". */
const RESTATES_MOTION = /\b(move|moved|seconded|second|motion)\b.*\bby\b/i;

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

export interface FoldedAnswerMatch {
  /** Index into the words of the answer's first word. */
  index: number;
  /**
   * What it answers: a motion (made or restated), a roll call, a vote put to
   * a member, or another question, which the asker may have answered
   * themselves.
   */
  answers: "motion" | "roll-call" | "vote" | "question";
  /** The answer, eg "Yes." */
  answer: string;
  /** The sentence that asked for it, or that restates the motion after it. */
  asked: string;
}

/** A title whose period doesn't end a sentence: "Ms. Brawley". */
const TITLE = /^(Mr|Ms|Mrs|Dr|St)\.$/;

/** Sentences as [first word index, text]. */
function sentences(words: readonly Word[]): [number, string][] {
  const out: [number, string][] = [];
  let start = 0;
  words.forEach((w, i) => {
    const ends = /[.?!]["')\]]*$/.test(w.text) && !TITLE.test(w.text);
    if (ends || i === words.length - 1) {
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
export function foldedAnswers(words: readonly Word[]): FoldedAnswerMatch[] {
  const found: FoldedAnswerMatch[] = [];
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
    found.push({
      index: first[0],
      answers: "motion",
      answer: first[1],
      asked: next[1],
    });
  for (let k = 1; k < sents.length; k++) {
    const [index, answer] = sents[k]!;
    const asked = sents[k - 1]![1];
    if (!ANSWER.test(answer)) continue;
    const motion = MOTION_ANSWER.test(answer);
    // "…, right? Yeah." is usually the speaker answering their own tag.
    const tag = /\bright\?$/i.test(asked);
    const answers =
      motion && CALLS_FOR_MOTION.test(asked)
        ? "motion"
        : ROLL_CALL.test(asked)
          ? "roll-call"
          : PUTS_VOTE.test(asked)
            ? "vote"
            : asked.endsWith("?") && !tag
              ? "question"
              : null;
    if (answers) found.push({ index, answers, answer, asked });
  }
  return found;
}

export const code = "folded-answer";

export type FoldedAnswer = Violation<typeof code> &
  AtWord & {
    /** The answer, eg "Yes." */
    answer: string;
    /** The sentence that asked for it, or that restates the motion after it. */
    asked: string;
    answers: FoldedAnswerMatch["answers"];
  };

export const defaultSeverity = "warning" satisfies Severity;

/**
 * A one-word answer ("Yes.", "Second.") in the same segment as the question,
 * roll call or call for a motion it answers.
 */
export function rule(meeting: RuleMeeting): FoldedAnswer[] {
  return meeting.segments.flatMap(({ words }, segment) =>
    foldedAnswers(words).map((f) => ({
      code,
      message: `${JSON.stringify(f.answer)} and ${JSON.stringify(f.asked)} are in one segment; the answer is probably someone else's. Give it its own segment under whoever was asked, or whoever the motion names`,
      segmentIndex: segment,
      wordIndex: f.index,
      atSecs: words[f.index]!.start,
      answer: f.answer,
      asked: f.asked,
      answers: f.answers,
    })),
  );
}

/**
 * Moves each answer to a motion, roll call or vote into a segment of its
 * own, with no speaker: someone else said it, but the words don't say who.
 * An answer to another question stays, since the asker may have answered it.
 */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly FoldedAnswer[],
): Fixed<M, FoldedAnswer> {
  const bySegment = new Map<number, FoldedAnswer[]>();
  for (const v of violations)
    if (v.answers !== "question")
      bySegment.set(v.segmentIndex, [
        ...(bySegment.get(v.segmentIndex) ?? []),
        v,
      ]);
  if (bySegment.size === 0) return { meeting, fixed: [] };
  const fixed: FoldedAnswer[] = [];
  const segments = meeting.segments.flatMap((seg, segmentIndex) => {
    const found = bySegment.get(segmentIndex);
    if (!found) return [seg];
    const pieces: (typeof seg)[] = [];
    let from = 0;
    for (const v of [...found].sort((a, b) => a.wordIndex - b.wordIndex)) {
      if (v.wordIndex < from) continue;
      const to = v.wordIndex + v.answer.split(" ").length;
      if (v.wordIndex > from)
        pieces.push({ ...seg, words: seg.words.slice(from, v.wordIndex) });
      pieces.push({
        ...seg,
        speakerNumber: null,
        person: null,
        words: seg.words.slice(v.wordIndex, to),
      });
      from = to;
      fixed.push(v);
    }
    if (from < seg.words.length)
      pieces.push({ ...seg, words: seg.words.slice(from) });
    return pieces;
  });
  return { meeting: { ...meeting, segments }, fixed };
}
