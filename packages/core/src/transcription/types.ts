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
   * (start + segmentSampleCount / sampleRate). Surrounding silence is excluded.
   */
  end: number;
  /** Words recognized in this run. Timestamps are absolute (offset by `start`). */
  words: TranscriptWord[];
}

export interface UnlabeledSpeaker {
  type: "unlabeled";
}
/** eg "speaker 3", we can recognize them across segments but don't know their real identity */
export interface SegmentedSpeaker {
  type: "segmented";
  speakerNumber: number;
}
/** A speaker with a known global identity (e.g. "Cathy Giessel, AK Senator"). */
export interface IdentifiedSpeaker {
  type: "identified";
  /**
   * Human-readable string identity (eg "cathy-giessel" in golden transcripts).
   * Deliberately NOT the serial `people.id` from the DB — mapping to DB rows
   * happens at the identify boundary, not in this type.
   */
  personId: string;
}
export type Speaker = UnlabeledSpeaker | SegmentedSpeaker | IdentifiedSpeaker;

export interface TranscriptSegment {
  speaker: Speaker;
  words: TranscriptWord[];
}

export interface DiarizationTurn {
  start: number;
  end: number;
  speaker: number;
}
