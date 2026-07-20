export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

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
