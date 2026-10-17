export type {
  DiarizationTurn,
  SpeechSegment,
  TranscriptSegment,
  TranscriptWord,
} from "./types.ts";
export { LAST_WORD_DURATION_SEC } from "./types";
export { type SplitSentence, splitSentences } from "./turn-edges";
export { type FoldedAnswer, foldedAnswers } from "./folded-answers";
export {
  alignSpeakers,
  MAX_WORD_SEC,
  segmentsToSpeechRuns,
  segmentsToTurns,
} from "./align";
export {
  type AlignedWordPair,
  type AlignmentOp,
  alignWords,
  compareTranscripts,
  computeWER,
  type TranscriptComparison,
  type WERResult,
} from "./wer";
