import type { Span } from "../span";
import type { Word } from "../transcript";

/**
 * A contiguous run of speech detected by voice-activity detection (VAD),
 * together with the words recognized within it. This is the unit transcribeAudio
 * emits: the audio is split at silences (not arbitrary time boundaries), so a
 * run never cuts a word mid-utterance.
 *
 * Distinct from a Segment, which groups words by *speaker* and carries no time
 * bounds. A SpeechRun is speaker-agnostic and time-bounded. Its span is the
 * silence-trimmed boundary VAD detected, i.e. the audio actually fed to the
 * recognizer; surrounding silence is excluded.
 */
export interface SpeechRun extends Span {
  /** Words recognized in this run. Timestamps are absolute (offset by `start`). */
  words: Word[];
}

/** A span in which diarization heard one cluster speaking. */
export interface DiarizationTurn extends Span {
  speakerNumber: number;
}
