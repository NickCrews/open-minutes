// The data a transcript is made of: words, grouped into segments by speaker.
// The stages that produce them are in ./transcription.

/**
 * A recognized word and the onset of its first token. The recognizer reports no
 * durations, so a word is taken to last until the next word in its speech run
 * starts, and a segment to end {@link LAST_WORD_DURATION_SEC} after its last
 * word's onset.
 */
export interface Word {
  text: string;
  start: number;
}

/**
 * Assumed duration of a segment's final word. The SQL function `words_end_secs`
 * (packages/db/src/migrations/20260720000542_derive-segment-times-from-words)
 * uses the same value; keep the two in sync.
 */
export const LAST_WORD_DURATION_SEC = 0.5;

/** A run of consecutive words spoken by one speaker. */
export interface Segment {
  /** Diarization's number for the speaker within this meeting; null if unknown. */
  speakerNumber: number | null;
  words: Word[];
}
