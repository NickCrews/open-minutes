/// <reference path="./sherpa-onnx-node.d.ts" />
import sherpa from "sherpa-onnx-node";
import { type AudioInput, ensureWaveForm } from "@open-minutes/codecs";
import { ensureDownloaded, type ModelSpec } from "./model.js";
import { EXPECTED_SAMPLE_RATE } from "./embed.js";
import type { Span } from "@open-minutes/core/span";

// Silero VAD: where in the audio someone is talking, independent of any
// transcript.
export const VAD_MODEL_SPEC = {
  name: "silero_vad",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  single_file: true,
  files: {
    "silero_vad.onnx": true,
  },
} as const satisfies ModelSpec;

export interface DetectSpeechOptions {
  /** Speech-probability threshold. */
  threshold?: number;
  /** Shortest pause that ends a run. */
  minSilenceSecs?: number;
  /** Drop runs shorter than this. */
  minSpeechSecs?: number;
  /** Force-split runs longer than this. */
  maxSpeechSecs?: number;
}

/** Downloads the VAD model if it is missing. */
export function loadVadModel(): void {
  ensureDownloaded(VAD_MODEL_SPEC);
}

/** Samples per Silero window at 16 kHz. */
const WINDOW_SIZE = 512;

/**
 * Speech runs found by Silero VAD, in time order. Runs force-split at
 * `maxSpeechSecs` that touch end to end are joined back together.
 */
export async function detectSpeech(
  audio: AudioInput,
  {
    threshold = 0.5,
    minSilenceSecs = 0.2,
    minSpeechSecs = 0.1,
    maxSpeechSecs = 60,
  }: DetectSpeechOptions = {},
): Promise<Span[]> {
  const wave = await ensureWaveForm(audio);
  const files = ensureDownloaded(VAD_MODEL_SPEC).files;
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: files["silero_vad.onnx"],
        threshold,
        minSilenceDuration: minSilenceSecs,
        minSpeechDuration: minSpeechSecs,
        maxSpeechDuration: maxSpeechSecs,
        windowSize: WINDOW_SIZE,
      },
      sampleRate: EXPECTED_SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    // The circular buffer must hold the longest run.
    maxSpeechSecs + 5,
  );
  const runs: Span[] = [];
  // Keep only each run's bounds: vad.front() copies the run's samples, and
  // holding on to them would duplicate the audio.
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      const start = seg.start / wave.sampleRate;
      const end = (seg.start + seg.samples.length) / wave.sampleRate;
      const last = runs.at(-1);
      if (last && start - last.end <= 0.01) last.end = end;
      else runs.push({ start, end });
      vad.pop();
    }
  };
  const { samples } = wave;
  for (let i = 0; i + WINDOW_SIZE <= samples.length; i += WINDOW_SIZE) {
    vad.acceptWaveform(samples.subarray(i, i + WINDOW_SIZE));
    drain();
  }
  vad.flush();
  drain();
  return runs;
}
