import type { RuleMeeting, Severity } from "./common";
import {
  type DroppedWord,
  dropWords,
  droppedWords,
  type FindDrops,
  wordCore,
} from "./words";

export const code = "false-start";

export type FalseStart = DroppedWord<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

// A word the speaker broke off and then restarted in full: the recognizer
// writes the fragment with a trailing hyphen ("six- sixteen", "re- reconsider").
// Only when the next word completes the fragment: a hyphen is also how the
// recognizer writes number separators ("twenty twenty six- twenty-three" is
// AO 2026-23) and suspended compounds ("pre- and post-war").
const findDrops: FindDrops = (words) =>
  words.map((word, i) => {
    const next = words[i + 1];
    if (!next || !/\p{L}-$/u.test(word.text)) return false;
    const fragment = wordCore(word.text).toLowerCase();
    const restart = wordCore(next.text).toLowerCase();
    return restart.length > fragment.length && restart.startsWith(fragment);
  });

/** An abandoned word fragment ("six- sixteen"). */
export function rule(meeting: RuleMeeting): FalseStart[] {
  return droppedWords(
    meeting,
    code,
    findDrops,
    (t) => `false-start ${JSON.stringify(t)}`,
  );
}

/** Drops each fragment, keeping the word that restarts it. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly FalseStart[],
) {
  return dropWords(meeting, violations, findDrops);
}
