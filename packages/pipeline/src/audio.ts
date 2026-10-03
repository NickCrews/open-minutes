// What the agent tools in @open-minutes/tools need from the models: reading a
// meeting's audio, finding speech in it, and decoding a stretch of it.
import sherpa, { type WaveForm } from "sherpa-onnx-node";

export type { WaveForm };
export { detectSpeech, type Span, SPEECH_RUNS_VERSION } from "./speech-runs";
export {
  loadTranscriptionModels,
  RANGE_CONTEXT_SEC,
  transcribeAudio,
  transcribeRange,
} from "./transcribe";
export { getCachedAudio, meetingCacheDir } from "./test-utils/audio-cache";

/** A 16-bit or float WAV file's samples. */
export function readWave(path: string): WaveForm {
  return sherpa.readWave(path);
}
