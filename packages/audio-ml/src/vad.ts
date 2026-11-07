/// <reference path="./sherpa-onnx-node.d.ts" />
import sherpa from "sherpa-onnx-node";
import { mergeSpans, type Span } from "@open-minutes/core/span";
import { ensureDownloaded, type ModelSpec } from "./model.js";
import {
  type AudioInput,
  type BaseOptions,
  EXPECTED_SAMPLE_RATE,
  prepareInput,
} from "./input.js";

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

export interface VoiceActivityOptions extends BaseOptions {
  /** Speech-probability threshold. */
  threshold?: number;
  /** Shortest pause that ends a span. */
  minSilenceSecs?: number;
  /** Drop spans shorter than this. */
  minSpeechSecs?: number;
  /** Force-split spans longer than this. */
  maxSpeechSecs?: number;
}

/** Downloads the VAD model if it is missing. */
export function loadVadModel(): void {
  ensureDownloaded(VAD_MODEL_SPEC);
}

/** Samples per Silero window at 16 kHz. */
const WINDOW_SIZE = 512;

/** How long Silero takes to hear speech already under way when a pass starts. */
const WARM_UP_SECS = 0.5;

/** Audio decoded either side of a mask span, at first, in seconds. */
const INITIAL_PADDING_SECS = 2;

/**
 * Voice activity spans found by Silero VAD, in time order, complete inside
 * the mask. A span that crosses the edge of the mask is returned whole. Spans
 * force-split at `maxSpeechSecs` that touch end to end are joined back
 * together.
 *
 * Each span of the mask is decoded with some padding either side. While a
 * voice activity span inside the mask reaches the edge of the decoded audio,
 * the padding on that side doubles and the pass is run again.
 */
export async function detectVoiceActivity(
  audio: AudioInput,
  opts: VoiceActivityOptions = {},
): Promise<Span[]> {
  const {
    threshold = 0.5,
    minSilenceSecs = 0.2,
    minSpeechSecs = 0.1,
    maxSpeechSecs = 60,
    signal,
  } = opts;
  const { wave, duration, mask } = await prepareInput(audio, opts);
  const settings = { threshold, minSilenceSecs, minSpeechSecs, maxSpeechSecs };
  const model = ensureDownloaded(VAD_MODEL_SPEC).files["silero_vad.onnx"];
  // A voice activity span this close to either end of a pass may continue
  // past it: the pause that would have ended it isn't in the pass, or Silero
  // was still warming up when the pass started in the middle of speech.
  const edgeSecs = minSilenceSecs + minSpeechSecs + WARM_UP_SECS;

  const found: Span[] = [];
  // Mask spans whose first passes would overlap share one.
  for (const span of mergeSpans(mask, 2 * INITIAL_PADDING_SECS)) {
    let before = INITIAL_PADDING_SECS;
    let after = INITIAL_PADDING_SECS;
    for (;;) {
      signal?.throwIfAborted();
      const from = Math.max(0, span.start - before);
      const to = Math.min(duration, span.end + after);
      const spans = vadPass(model, wave.samples, from, to, settings).filter(
        (s) => s.end > span.start && s.start < span.end,
      );
      const first = spans[0];
      const last = spans.at(-1);
      const cutAtStart = from > 0 && first && first.start - from < edgeSecs;
      const cutAtEnd = to < duration && last && to - last.end < edgeSecs;
      if (!cutAtStart && !cutAtEnd) {
        found.push(...spans);
        break;
      }
      if (cutAtStart) before *= 2;
      if (cutAtEnd) after *= 2;
    }
  }
  // Passes over neighbouring mask spans can find the same voice activity span.
  return mergeSpans(found, 0.01);
}

/** Voice activity spans in samples [from, to) of `samples`, in seconds from the start of the file. */
function vadPass(
  model: string,
  samples: Float32Array,
  from: number,
  to: number,
  settings: Required<Omit<VoiceActivityOptions, keyof BaseOptions>>,
): Span[] {
  const rate = EXPECTED_SAMPLE_RATE;
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model,
        threshold: settings.threshold,
        minSilenceDuration: settings.minSilenceSecs,
        minSpeechDuration: settings.minSpeechSecs,
        maxSpeechDuration: settings.maxSpeechSecs,
        windowSize: WINDOW_SIZE,
      },
      sampleRate: rate,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    // The circular buffer must hold the longest span.
    settings.maxSpeechSecs + 5,
  );
  const offset = Math.round(from * rate);
  const spans: Span[] = [];
  // Keep only each span's bounds: vad.front() copies the span's samples, and
  // holding on to them would duplicate the audio.
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      const start = (offset + seg.start) / rate;
      const end = (offset + seg.start + seg.samples.length) / rate;
      const last = spans.at(-1);
      if (last && start - last.end <= 0.01) last.end = end;
      else spans.push({ start, end });
      vad.pop();
    }
  };
  const audio = samples.subarray(offset, Math.round(to * rate));
  for (let i = 0; i + WINDOW_SIZE <= audio.length; i += WINDOW_SIZE) {
    vad.acceptWaveform(audio.subarray(i, i + WINDOW_SIZE));
    drain();
  }
  vad.flush();
  drain();
  return spans;
}
