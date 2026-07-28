/**
 * A recognized word and the onset of its first token. Only the onset is stored:
 * the recognizer reports no durations, so any "end" would be an estimate. Where
 * word-level ends are needed (speaker alignment), they are derived from the
 * surrounding structure — a word lasts until the next word in its speech run
 * starts, or until the run ends. Where only a segment-level end is needed, it is
 * approximated as the last word's onset plus {@link LAST_WORD_DURATION_SEC}.
 */
export interface TranscriptWord {
  text: string;
  start: number;
}

/**
 * Assumed duration of a segment's final word when approximating the segment's
 * end from word onsets alone. Mirrored in the SQL function `words_end_secs`
 * (see the drop-word-end-timestamps migration) — keep the two in sync.
 */
export const LAST_WORD_DURATION_SEC = 0.5;

/**
 * A contiguous run of speech detected by voice-activity detection (VAD),
 * together with the words recognized within it. This is the unit transcribeAudio
 * emits: the audio is split at silences (not arbitrary time boundaries), so a
 * segment never cuts a word mid-utterance.
 *
 * Distinct from {@link TranscriptSegment}, which groups words by *speaker* and
 * carries no time bounds. A SpeechSegment is speaker-agnostic and time-bounded.
 */
export interface SpeechSegment {
  /**
   * Seconds from the start of the audio to where this speech run begins — the
   * silence-trimmed boundary VAD detected, i.e. the start of the audio actually
   * fed to the recognizer. Surrounding silence is excluded.
   */
  start: number;
  /**
   * Seconds from the start of the audio to where this speech run ends
   * (start + (samples.length / sampleRate)). Surrounding silence is excluded.
   */
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
