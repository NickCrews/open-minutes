import type { RuleMeeting, Severity } from "./common";
import {
  type DroppedWord,
  dropWords,
  droppedWords,
  type FindDrops,
  wordCore,
} from "./words";

export const code = "filler-word";

export type FillerWord = DroppedWord<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

// Hesitation sounds with no lexical content, matched case-insensitively against
// the word stripped of punctuation. Deliberately narrow: "oh", "ah", "hmm" and
// "mm-hmm" often carry meaning ("Oh, I see"; "Mm-hmm" for yes), and "uh-huh" /
// "uh-oh" survive because the hyphen keeps them from matching.
const FILLER_PATTERN = /^(?:u+[hm]+|e+r+m+)$/i;

/** Whether `text` (one recognized word, punctuation included) is a filler word. */
export function isFillerWord(text: string): boolean {
  return FILLER_PATTERN.test(wordCore(text));
}

const findDrops: FindDrops = (words) => words.map((w) => isFillerWord(w.text));

/** A hesitation sound ("um", "uh", "erm"). */
export function rule(meeting: RuleMeeting): FillerWord[] {
  return droppedWords(
    meeting,
    code,
    findDrops,
    (t) => `filler ${JSON.stringify(t)}`,
  );
}

/** Drops each filler word. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly FillerWord[],
) {
  return dropWords(meeting, violations, findDrops);
}
