// The data a transcript is made of: words, grouped into segments by speaker.
// The stages that produce them are in ./transcription.

/**
 * A recognized word and the onset of its first token. Only the onset is stored:
 * the recognizer reports no durations, so any "end" would be an estimate. Where
 * word-level ends are needed (speaker alignment), they are derived from the
 * surrounding structure — a word lasts until the next word in its speech run
 * starts, or until the run ends. Where only a segment-level end is needed, it is
 * approximated as the last word's onset plus {@link LAST_WORD_DURATION_SEC}.
 */
export interface Word {
  text: string;
  start: number;
}

/**
 * Assumed duration of a segment's final word when approximating the segment's
 * end from word onsets alone. Mirrored in the SQL function `words_end_secs`
 * (see the drop-word-end-timestamps migration) — keep the two in sync.
 */
export const LAST_WORD_DURATION_SEC = 0.5;

/** A run of consecutive words spoken by one speaker. */
export interface Segment {
  /** Diarization's number for the speaker within this meeting; null if unknown. */
  speakerNumber: number | null;
  words: Word[];
}
