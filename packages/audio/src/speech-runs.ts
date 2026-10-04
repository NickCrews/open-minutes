/// <reference path="./sherpa-onnx-node.d.ts" />
import sherpa, { type WaveForm } from "sherpa-onnx-node";
import { ensureDownloaded } from "./model.js";
import { VAD_MODEL_SPEC } from "./transcribe.js";
import { EXPECTED_SAMPLE_RATE } from "./embed.js";

// Where in the audio someone is talking, by Silero VAD, independent of any
// transcript. The transcriber runs the same model to cut the audio into
// chunks, but with a 0.5 s minimum silence; here pauses down to 0.2 s count,
// so a turn boundary between two speakers shows up as a gap.

/** A span of the audio, in seconds. */
export interface Span {
  start: number;
  end: number;
}

const VAD_THRESHOLD = 0.5;
const VAD_MIN_SILENCE_SEC = 0.2;
const VAD_MIN_SPEECH_SEC = 0.1;
const VAD_MAX_SPEECH_SEC = 60;
const VAD_WINDOW_SIZE = 512;

/**
 * Bump when the settings above change, so speech runs cached from the old
 * ones are recomputed.
 */
export const SPEECH_RUNS_VERSION = 1;

/** Every speech run in `wave`, in time order, to the hundredth of a second. */
export function detectSpeech(wave: WaveForm): Span[] {
  const files = ensureDownloaded(VAD_MODEL_SPEC).files;
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: files["silero_vad.onnx"],
        threshold: VAD_THRESHOLD,
        minSilenceDuration: VAD_MIN_SILENCE_SEC,
        minSpeechDuration: VAD_MIN_SPEECH_SEC,
        maxSpeechDuration: VAD_MAX_SPEECH_SEC,
        windowSize: VAD_WINDOW_SIZE,
      },
      sampleRate: EXPECTED_SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    VAD_MAX_SPEECH_SEC + 5,
  );
  const runs: Span[] = [];
  const round = (secs: number) => Math.round(secs * 100) / 100;
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      const start = round(seg.start / wave.sampleRate);
      const end = round((seg.start + seg.samples.length) / wave.sampleRate);
      // Runs force-split at VAD_MAX_SPEECH_SEC abut; join them back up.
      const last = runs.at(-1);
      if (last && start - last.end <= 0.01) last.end = end;
      else runs.push({ start, end });
      vad.pop();
    }
  };
  const { samples } = wave;
  for (let i = 0; i + VAD_WINDOW_SIZE <= samples.length; i += VAD_WINDOW_SIZE) {
    vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW_SIZE));
    drain();
  }
  vad.flush();
  drain();
  return runs;
}
