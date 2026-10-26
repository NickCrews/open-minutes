import type { Span } from "../span";
import type { Word } from "../transcript";

/**
 * A run of speech between silences, found by voice-activity detection (VAD),
 * with the words recognized in it; what transcribeAudio emits. Unlike a
 * Segment, it has time bounds and no speaker. Its span excludes the
 * surrounding silence.
 */
export interface SpeechRun extends Span {
  /** Words recognized in this run. Timestamps are absolute (offset by `start`). */
  words: Word[];
}

/** A span in which diarization heard one cluster speaking. */
export interface DiarizationTurn extends Span {
  speakerNumber: number;
}
