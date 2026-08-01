import {
  LAST_WORD_DURATION_SEC,
  type DiarizationTurn,
  type SpeechSegment,
  type TranscriptSegment,
  type TranscriptWord,
} from "@open-minutes/core/transcription";

/**
 * A word with its derived end time. Stored words carry only their onset; ends
 * exist only in memory here, derived from the run structure by
 * {@link deriveTimedWords}.
 */
interface TimedWord {
  word: TranscriptWord;
  end: number;
}

/** A TranscriptSegment whose words still carry their derived ends. */
interface TimedSegment {
  speakerNum: number | null;
  words: TimedWord[];
}

/**
 * How long a single word may sound. Parakeet reports one timestamp per token —
 * the token's onset, quantized to the encoder's ~12.5 fps frame grid — and no
 * durations, so a word's end has to be estimated. Measured on this model,
 * consecutive tokens inside continuous speech land 0.08-0.24s apart; 0.32s
 * (4 frames) is a generous ceiling on that.
 *
 * The upper bound matters more than the exact value: it is deliberately below
 * transcribe.ts's VAD_MIN_SILENCE_SEC, so a derived word end can never span a
 * pause long enough for VAD to have cut at it. That is what stops a word from
 * reaching across a silence into the next speaker's diarization turn.
 */
export const MAX_WORD_SEC = 0.32;

/**
 * Derive each word's end from its onset: a word sounds for at most
 * MAX_WORD_SEC, truncated at the next word's onset so words never overlap.
 *
 * The run structure is what makes the ceiling *sufficient*, not what supplies
 * the end. Deriving a run-final word's end from `run.end` instead is unsafe in
 * both directions, and both were measured on the real meetings: VAD's endpoint
 * can trail its last word by seconds (up to 6.3s), stretching that word across
 * the silence and onto the next speaker; or it can land *before* the last
 * word's onset (74% of runs, since splitWordsIntoRuns parks a word that fell in
 * an inter-run silence on the preceding run), collapsing the word to zero width
 * so it loses every overlap comparison in assignSpeaker.
 *
 * The truncation spans the flattened stream rather than each run separately.
 * The recognizer's onsets run continuously across run boundaries — a decode
 * window covers several runs and reports window-relative times — so consecutive
 * words can sit 0.08s apart while straddling a boundary. Clamping only within a
 * run lets such a word overlap the next run's first word (170 of 919 boundaries
 * on gbos_xTDznaSElgY).
 */
function deriveTimedWords(speech: readonly SpeechSegment[]): TimedWord[] {
  // Runs are in time order and each holds a contiguous slice of the ordered
  // word stream, so flattening recovers that stream.
  const words = speech.flatMap((run) => run.words);
  return words.map((word, i) => ({
    word,
    end: Math.min(word.start + MAX_WORD_SEC, words[i + 1]?.start ?? Infinity),
  }));
}

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
  speech: readonly SpeechSegment[],
  turns: readonly DiarizationTurn[],
): TranscriptSegment[] {
  const words = deriveTimedWords(speech);
  if (words.length === 0) return [];
  if (turns.length === 0) {
    return [{ speakerNum: null, words: words.map((t) => t.word) }];
  }

  const segments: TimedSegment[] = [];
  let current: TimedSegment | null = null;
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
  return absorbSlivers(segments).map((s) => ({
    speakerNum: s.speakerNum,
    words: s.words.map((t) => t.word),
  }));
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
      end: segment.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
      speakerNum: segment.speakerNum,
    });
  }
  return turns;
}

/**
 * Wrap already-grouped segments as pseudo speech runs so they can be re-aligned
 * — used when refreshing a golden's diarization layer, where the original VAD
 * run structure is gone. Each segment becomes one run ending shortly after its
 * last word's onset. Coarser than real runs: pauses *inside* a segment are
 * invisible (a derived word end spans them), so sliver absorption is slightly
 * more eager here than in the live pipeline.
 */
export function segmentsToSpeechRuns(
  segments: readonly { words: readonly TranscriptWord[] }[],
): SpeechSegment[] {
  return segments
    .filter((s) => s.words.length > 0)
    .map((s) => ({
      start: s.words[0]!.start,
      end: s.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
      words: [...s.words],
    }));
}

/** Longest sliver, in words, that a mid-sentence clustering wobble can produce. */
const MAX_SLIVER_WORDS = 5;
/** Longest a wobble can last. Past this the sliver held the floor — a real turn. */
const MAX_SLIVER_SEC = 2.0;
/**
 * Longest silence allowed anywhere across the sliver and its two boundaries.
 * Matches transcribe.ts's VAD_MIN_SILENCE_SEC: a gap that long is a pause the
 * VAD would have called a break in speech, and speech resuming after a pause is
 * someone taking a turn. Since derived word ends absorb intra-run gaps, a gap
 * this long can only appear at a run boundary — exactly where VAD saw a pause.
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
function absorbSlivers(segments: TimedSegment[]): TimedSegment[] {
  const merged: TimedSegment[] = [];
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
  previous: TimedSegment,
  sliver: TimedSegment,
  next: TimedSegment,
): boolean {
  if (sliver.words.length > MAX_SLIVER_WORDS) return false;

  const first = sliver.words[0];
  const last = sliver.words.at(-1);
  if (first === undefined || last === undefined) return false;
  if (last.end - first.word.start > MAX_SLIVER_SEC) return false;

  // The neighbourhood the sentence has to run through unbroken: the tail of the
  // previous segment, the sliver, and the head of the next.
  const around = [
    ...previous.words.slice(-PUNCTUATION_WINDOW_WORDS),
    ...sliver.words,
    ...next.words.slice(0, PUNCTUATION_WINDOW_WORDS),
  ];
  if (around.some((t) => endsSentence(t.word))) return false;
  for (let i = 1; i < around.length; i++) {
    if (around[i]!.word.start - around[i - 1]!.end > MAX_WORD_GAP_SEC)
      return false;
  }
  return true;
}

function sameSpeaker(a: TimedSegment, b: TimedSegment): boolean {
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
  timed: TimedWord,
  turns: readonly DiarizationTurn[],
): number {
  let bestSpeaker = turns[0]!.speakerNum;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap =
      Math.min(timed.end, turn.end) - Math.max(timed.word.start, turn.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = turn.speakerNum;
    }
  }
  if (bestOverlap > 0) return bestSpeaker;

  // No turn overlaps this word — attach it to the nearest by midpoint distance.
  const mid = (timed.word.start + timed.end) / 2;
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
