export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export interface UnlabeledSpeaker {
  type: "unlabeled";
}
/** eg "speaker 3", we can recognize them across segments but don't know their real identity */
export interface SegmentedSpeaker {
  type: "segmented";
  speakerNumber: number;
}
/** A speaker with a known identity (e.g. "Alice") that can be linked across segments. */
export interface LabeledSpeaker {
  type: "labeled";
  personId: string;
}
export type Speaker = UnlabeledSpeaker | SegmentedSpeaker | LabeledSpeaker;

export interface TranscriptSegment {
  speaker: Speaker;
  words: TranscriptWord[];
}

export interface DiarizationTurn {
  start: number;
  end: number;
  speaker: number;
}
