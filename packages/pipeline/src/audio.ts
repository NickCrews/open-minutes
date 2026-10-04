// What the agent tools in @open-minutes/tools need from the models: reading a
// meeting's audio, finding speech in it, and decoding a stretch of it.
export { readWave, type WaveForm } from "@open-minutes/audio/wav";
export {
  detectSpeech,
  type Span,
  SPEECH_RUNS_VERSION,
} from "@open-minutes/audio/speech-runs";
export {
  loadTranscriptionModels,
  RANGE_CONTEXT_SEC,
  transcribeAudio,
  transcribeRange,
} from "@open-minutes/audio/transcribe";
export { getCachedAudio, meetingCacheDir } from "./test-utils/audio-cache";
