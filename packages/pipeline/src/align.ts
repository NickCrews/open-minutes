import type {
  DiarizationTurn,
  TranscriptSegment,
  TranscriptWord,
} from "@open-minutes/core/transcription";

/**
 * Combine a diarization output and a transcript into speaker-labeled segments.
 *
 * The diarization is a sequence of "person 4 spoke from 1:23 to 1:27",
 * and the transcript is a sequence of "the words 'foo bar' were spoken from 1:24 to 1:25".
 * This function produces a sequence of "person 4 said 'foo bar' from 1:24 to 1:25".
 *
 * It does this by assigning each word to the diarization turn it overlaps most, and then
 * grouping consecutive words with the same speaker into segments. It also absorbs
 * spurious one-or-two-word speaker changes inside a single utterance, which can
 * happen due to clustering wobble in the diarization output.
 */
export function alignSpeakers(
  words: readonly TranscriptWord[],
  turns: readonly DiarizationTurn[],
): TranscriptSegment[] {
  if (words.length === 0) return [];
  if (turns.length === 0) {
    return [{ speakerNum: null, words: [...words] }];
  }

  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;
  let currentSpeaker: number | null = null;

  for (const word of words) {
    const speakerNum = assignSpeaker(word, turns);
    if (current === null || speakerNum !== currentSpeaker) {
      current = {
        speakerNum: speakerNum,
        words: [],
      };
      currentSpeaker = speakerNum;
      segments.push(current);
    }
    current.words.push(word);
  }
  return absorbSlivers(segments);
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
    if (segment.speakerNum === null) continue;
    if (segment.words.length === 0) continue;
    turns.push({
      start: segment.words[0]!.start,
      end: segment.words.at(-1)!.end,
      speakerNum: segment.speakerNum,
    });
  }
  return turns;
}

/** Longest sliver, in words, that a mid-sentence clustering wobble can produce. */
const MAX_SLIVER_WORDS = 5;
/** Longest a wobble can last. Past this the sliver held the floor — a real turn. */
const MAX_SLIVER_SEC = 2.0;
/**
 * Longest silence allowed anywhere across the sliver and its two boundaries.
 * Matches transcribe.ts's VAD_MIN_SILENCE_SEC: a gap that long is a pause the
 * VAD would have called a break in speech, and speech resuming after a pause is
 * someone taking a turn.
 */
const MAX_WORD_GAP_SEC = 0.5;
/** How far either side of a boundary a full stop still disqualifies the merge. */
const PUNCTUATION_WINDOW_WORDS = 2;

/**
 * Fold away spurious one-or-two-word speaker changes inside a single utterance.
 *
 * The raw transcription + diarization output can wobble between two speakers:
 *    Mélisa Babb:      ...a rezone to a residential district would not necessarily be supported
 *    Radhika Krishna:  in that area
 *    Mélisa Babb:      by the plan because that area is envisioned as...
 *
 * The middle line is a few word sliver that the clustering algorithm misattributed to Radhika.
 * This should be one continuous turn by Mélisa.
 * The tricky thing is distinguishing a real interjection from a clustering wobble.
 *
 * We use the conditions:
 *   - no full stop near either boundary
 *   - no pause between any two words across it
 *   - the sliver itself is over quickly.
 *
 * Anything else — a completed sentence, a beat of silence, a sliver
 * that holds the floor for seconds — is someone taking a turn, and is left
 * alone. Where all of it holds, the three segments become one.
 */
function absorbSlivers(segments: TranscriptSegment[]): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const previous = merged.at(-1);
    const sliver = segments[i]!;
    const next = segments[i + 1];
    if (
      previous !== undefined &&
      next !== undefined &&
      sameSpeaker(previous, next) &&
      !sameSpeaker(previous, sliver) &&
      isWobble(previous, sliver, next)
    ) {
      previous.words.push(...sliver.words, ...next.words);
      i++; // `next` has been folded in; don't emit it again.
      continue;
    }
    merged.push(sliver);
  }
  return merged;
}

/** Whether a sliver looks like a clustering wobble inside one continuous utterance. */
function isWobble(
  previous: TranscriptSegment,
  sliver: TranscriptSegment,
  next: TranscriptSegment,
): boolean {
  if (sliver.words.length > MAX_SLIVER_WORDS) return false;

  const first = sliver.words[0];
  const last = sliver.words.at(-1);
  if (first === undefined || last === undefined) return false;
  if (last.end - first.start > MAX_SLIVER_SEC) return false;

  // The neighbourhood the sentence has to run through unbroken: the tail of the
  // previous segment, the sliver, and the head of the next.
  const around = [
    ...previous.words.slice(-PUNCTUATION_WINDOW_WORDS),
    ...sliver.words,
    ...next.words.slice(0, PUNCTUATION_WINDOW_WORDS),
  ];
  if (around.some(endsSentence)) return false;
  for (let i = 1; i < around.length; i++) {
    if (around[i]!.start - around[i - 1]!.end > MAX_WORD_GAP_SEC) return false;
  }
  return true;
}

function sameSpeaker(a: TranscriptSegment, b: TranscriptSegment): boolean {
  if (a.speakerNum === null || b.speakerNum === null) {
    return false;
  }
  return a.speakerNum === b.speakerNum;
}

/** Whether a word closes a sentence. */
function endsSentence(word: TranscriptWord): boolean {
  return /[.?!]["')\]]?$/.test(word.text);
}

/** The diarization turn a word overlaps most; ties/zero-overlap fall back to nearest midpoint. */
function assignSpeaker(
  word: TranscriptWord,
  turns: readonly DiarizationTurn[],
): number {
  let bestSpeaker = turns[0]!.speakerNum;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap =
      Math.min(word.end, turn.end) - Math.max(word.start, turn.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = turn.speakerNum;
    }
  }
  if (bestOverlap > 0) return bestSpeaker;

  // No turn overlaps this word — attach it to the nearest by midpoint distance.
  const mid = (word.start + word.end) / 2;
  let nearestSpeaker = turns[0]!.speakerNum;
  let nearestDistance = Infinity;
  for (const turn of turns) {
    const distance = Math.abs(mid - (turn.start + turn.end) / 2);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestSpeaker = turn.speakerNum;
    }
  }
  return nearestSpeaker;
}
