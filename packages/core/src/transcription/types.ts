/**
 * A recognized word and the onset of its first token. The recognizer reports no
 * durations, so a word is taken to last until the next word in its speech run
 * starts, and a segment to end {@link LAST_WORD_DURATION_SEC} after its last
 * word's onset.
 */
export interface TranscriptWord {
  text: string;
  start: number;
}

/**
 * Assumed duration of a segment's final word. The SQL function `words_end_secs`
 * (packages/db/src/migrations/20260720000542_derive-segment-times-from-words)
 * uses the same value; keep the two in sync.
 */
export const LAST_WORD_DURATION_SEC = 0.5;

/**
 * A run of speech between silences, found by voice-activity detection (VAD),
 * with the words recognized in it; what transcribeAudio emits. Unlike
 * {@link TranscriptSegment}, it has time bounds and no speaker.
 */
export interface SpeechSegment {
  /** Seconds from the start of the audio to the run's start, silence excluded. */
  start: number;
  /** Seconds from the start of the audio to the run's end, silence excluded. */
  end: number;
  /** Words recognized in this run. Timestamps are absolute (offset by `start`). */
  words: TranscriptWord[];
}

export interface TranscriptSegment {
  speakerNum: number | null;
  words: TranscriptWord[];
}

export interface DiarizationTurn {
  start: number;
  end: number;
  speakerNum: number;
}
