import type {
  DiarizationTurn,
  TranscriptSegment,
  TranscriptWord,
} from "@open-minutes/core/transcription";

// Attach speakers to a transcript by time overlap — the offline-only port of
// OpenWhispr's mergeWithTranscript. There's no mic/system split here (single
// YouTube track), so every word is matched the same way: pick the diarization
// turn it overlaps most, falling back to the nearest turn by midpoint distance.
//
// transcribe.ts emits one ~2-minute segment per chunk, so we align at the word
// level and then regroup consecutive same-speaker words into speaker turns.

/**
 * Re-segment a flat word stream into speaker-labeled segments using diarization
 * turns. With no turns, returns the words as a single unlabeled segment.
 */
export function alignSpeakers(
  words: readonly TranscriptWord[],
  turns: readonly DiarizationTurn[],
): TranscriptSegment[] {
  if (words.length === 0) return [];
  if (turns.length === 0) {
    return [{ speaker: { type: "unlabeled" }, words: [...words] }];
  }

  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;
  let currentSpeaker: number | null = null;

  for (const word of words) {
    const speaker = assignSpeaker(word, turns);
    if (current === null || speaker !== currentSpeaker) {
      current = {
        speaker: { type: "segmented", speakerNumber: speaker },
        words: [],
      };
      currentSpeaker = speaker;
      segments.push(current);
    }
    current.words.push(word);
  }
  return segments;
}

/** The diarization turn a word overlaps most; ties/zero-overlap fall back to nearest midpoint. */
function assignSpeaker(
  word: TranscriptWord,
  turns: readonly DiarizationTurn[],
): number {
  let bestSpeaker = turns[0]!.speaker;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap =
      Math.min(word.end, turn.end) - Math.max(word.start, turn.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = turn.speaker;
    }
  }
  if (bestOverlap > 0) return bestSpeaker;

  // No turn overlaps this word — attach it to the nearest by midpoint distance.
  const mid = (word.start + word.end) / 2;
  let nearestSpeaker = turns[0]!.speaker;
  let nearestDistance = Infinity;
  for (const turn of turns) {
    const distance = Math.abs(mid - (turn.start + turn.end) / 2);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestSpeaker = turn.speaker;
    }
  }
  return nearestSpeaker;
}

/**
 * Derive diarization turns from already-labeled segments — used to re-apply an
 * existing golden's speaker boundaries onto a freshly re-transcribed word stream
 * (so a transcription snapshot refresh preserves the diarization layer).
 * Only `segmented` segments contribute; unlabeled/identified are skipped.
 */
export function segmentsToTurns(
  segments: readonly TranscriptSegment[],
): DiarizationTurn[] {
  const turns: DiarizationTurn[] = [];
  for (const segment of segments) {
    if (segment.speaker.type !== "segmented") continue;
    if (segment.words.length === 0) continue;
    turns.push({
      start: segment.words[0]!.start,
      end: segment.words.at(-1)!.end,
      speaker: segment.speaker.speakerNumber,
    });
  }
  return turns;
}
