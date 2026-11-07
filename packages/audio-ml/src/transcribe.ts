/// <reference path="./sherpa-onnx-node.d.ts" />
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { ensureDownloaded, ModelSpec } from "./model.js";
import { assertSampleRate, EXPECTED_SAMPLE_RATE } from "./input.js";
import {
  type AudioInput,
  ensureWaveForm,
  type WaveForm,
} from "@open-minutes/codecs";
import {
  detectVoiceActivity,
  type VoiceActivityOptions,
  loadVadModel,
} from "./vad.js";

import sherpa_onnx, {
  type OfflineRecognizer,
  type OfflineRecognizerResult,
} from "sherpa-onnx-node";
import type { Word } from "@open-minutes/core/transcript";
import type { SpeechRun } from "@open-minutes/core/transcription";

export const TRANSCRIPTION_MODEL_SPEC = {
  // I chose this model based on how it is the highest accuracy with still a >3000x real-time facto
  // according to https://huggingface.co/spaces/hf-audio/open_asr_leaderboard
  // Keep your eye on that leaderboard. If there's a new model with better accuracy
  // that maintains that speed, we should switch to it.
  name: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
  files: {
    "encoder.int8.onnx": true,
    "decoder.int8.onnx": true,
    "joiner.int8.onnx": true,
    "tokens.txt": true,
    test_wavs: {
      "en.wav": true,
      "fr.wav": true,
      "es.wav": true,
      "de.wav": true,
    },
  },
} as const satisfies ModelSpec;

// How well this does is measured, and what the model does is written down, in
// ./transcription-quality/ (see its README.md). Judge a change here by the
// north star there: word error rate and runtime.

// Both the recognizer and Silero VAD expect 16 kHz mono (EXPECTED_SAMPLE_RATE).
// @open-minutes/youtube's audio download produces that; we assert rather than
// resample.

// Parakeet TDT processes audio in a single pass. Its encoder uses a learned
// positional embedding (~5000 positions at the encoder's ~12.5 frames/sec output
// rate), so one pass tops out around ~400s of audio; beyond that ONNX throws a
// (catchable, non-fatal) broadcast error — verified empirically, it does NOT
// crash or OOM. Rather than slicing on fixed time boundaries — which cut words
// mid-utterance — we use Silero VAD to split the audio at silences. VAD picks the
// cut points (never mid-word); we then merge consecutive voice activity spans into windows of
// up to MERGE_WINDOW_SEC (see below) so each decode gets real context, keeping
// every pass well under the ~400s cap.

/**
 * The VAD settings transcribeAudio cuts the audio with. `MAX_WORD_SEC` in core
 * must stay below `minSilenceSecs`, so a derived word end can't reach across a
 * pause into the next speaker's turn. `maxSpeechSecs` force-splits any span
 * longer than 5 min (preferring the last silence), so no span alone exceeds
 * Parakeet's ~400 s cap.
 */
export const TRANSCRIBE_VAD_OPTIONS = {
  minSilenceSecs: 0.5,
  minSpeechSecs: 0.25,
  maxSpeechSecs: 300,
} as const satisfies VoiceActivityOptions;

// VAD splits at every silence, so a meeting yields ~1000 spans, many under 0.5s.
// Decoding each span alone starves Parakeet of context (hurting accuracy) and pays
// the per-decode overhead ~1000×. So we coalesce consecutive spans into windows of
// up to this many seconds and decode each in one pass — comfortably under the
// ~400s cap, but large enough to give the model real surrounding context. The
// window is a contiguous slice (inter-span silences included, so timestamps stay
// linear); a single span longer than this still becomes its own window
// (≤ TRANSCRIBE_VAD_OPTIONS.maxSpeechSecs).
export const MERGE_WINDOW_SEC = 120;

// Transcribe speech runs in parallel, but bounded: a long meeting produces ~1000
// runs and each concurrent decode holds a chunk of native onnxruntime memory, so
// an unbounded pool blows up RAM. Cap concurrency to keep peak memory in check
// while still using multiple cores. (Even sequential is RTF ~0.04 here, so a
// small cap costs little.)
const TRANSCRIBE_CONCURRENCY = Math.max(1, Math.min(4, availableParallelism()));

export interface TranscribeWindowEvent {
  windowIndex: number;
  windowStart: number;
  windowEnd: number;
  wallStartMs: number;
}

export interface TranscribeWindowEndEvent extends TranscribeWindowEvent {
  wallEndMs: number;
}

/** Optional callbacks fired as decode windows are processed. */
export interface TranscribeTracing {
  onWindowStart?(event: TranscribeWindowEvent): void;
  onWindowEnd?(event: TranscribeWindowEndEvent): void;
}

export interface TranscribeOptions {
  tracing?: TranscribeTracing;
}

/**
 * Transcribe audio into speech runs. Silero VAD splits the audio at silences
 * (never mid-word); consecutive voice activity spans are merged into windows of up to
 * MERGE_WINDOW_SEC that are each decoded in one pass (so the model gets context),
 * then each window's words are redistributed back to the spans they fall in.
 * The result is one {@link SpeechRun} per voice activity span, with absolute word
 * timestamps, in time order. Returns [] for silence. Input must be 16 kHz mono.
 */
export async function transcribeAudio(
  audio: AudioInput,
  options: TranscribeOptions = {},
): Promise<SpeechRun[]> {
  const wallStart = Date.now();
  const wave = await ensureWaveForm(audio);
  assertSampleRate(wave.sampleRate);
  const duration = wave.samples.length / wave.sampleRate;
  const { tracing } = options;

  // detectVoiceActivity gives seconds; windows are sliced from the waveform by
  // sample index.
  const voiceSpans: SampleSpan[] = (
    await detectVoiceActivity(wave, TRANSCRIBE_VAD_OPTIONS)
  ).map((span) => ({
    startSample: Math.round(span.start * wave.sampleRate),
    endSample: Math.round(span.end * wave.sampleRate),
  }));
  const windows = packWindows(voiceSpans, wave.sampleRate);
  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(
    `Transcribing ${typeof audio === "string" ? audio : "<waveform>"} (${duration.toFixed(1)}s) in ${windows.length} window(s) merged from ${voiceSpans.length} voice activity span(s)...`,
  );

  const windowSegments = await mapWithConcurrency(
    windows,
    TRANSCRIBE_CONCURRENCY,
    async (win, i): Promise<SpeechRun[]> => {
      const start = win.startSample / wave.sampleRate;
      const end = win.endSample / wave.sampleRate;
      // Zero-copy view into the original waveform — never copy the window's samples
      // (copying every window would duplicate the audio).
      const samples = wave.samples.subarray(win.startSample, win.endSample);

      const wallStartMs = Date.now();
      tracing?.onWindowStart?.({
        windowIndex: i,
        windowStart: start,
        windowEnd: end,
        wallStartMs,
      });
      const result = await transcribeSamples(samples, wave.sampleRate);
      tracing?.onWindowEnd?.({
        windowIndex: i,
        windowStart: start,
        windowEnd: end,
        wallStartMs,
        wallEndMs: Date.now(),
      });

      const words = tokensToWords(
        result.tokens ?? [],
        result.timestamps ?? [],
      ).map((w) => ({ ...w, start: w.start + start }));
      return splitWordsIntoRuns(win.spans, words, wave.sampleRate);
    },
  );

  const elapsed = (Date.now() - wallStart) / 1000;
  console.error(
    `Done: ${duration.toFixed(1)}s audio in ${elapsed.toFixed(1)}s (RTF=${(elapsed / duration).toFixed(2)})`,
  );

  return windowSegments.flat();
}

/**
 * How much audio either side of the requested range transcribeRange decodes.
 * The recognizer hears a word cut off at the edge of what it's given poorly,
 * and the words around it guess better with their neighbours; a couple of
 * seconds covers a word and a half either side.
 */
export const RANGE_CONTEXT_SEC = 2;

/**
 * Recognize one stretch of audio in a single pass, without VAD: the words
 * whose onsets fall in [start, end) of the waveform, with absolute onsets.
 * The pass decodes `contextSecs` more either side, so the model gets lead-in
 * and lead-out, and the words found there are dropped. For a closer look at a
 * short range (under a few minutes); transcribeAudio is for whole meetings.
 */
export async function transcribeRange(
  wave: WaveForm,
  start: number,
  end: number,
  { contextSecs = RANGE_CONTEXT_SEC } = {},
): Promise<Word[]> {
  assertSampleRate(wave.sampleRate);
  const rate = wave.sampleRate;
  const from = Math.max(0, Math.floor((start - contextSecs) * rate));
  const to = Math.min(
    wave.samples.length,
    Math.ceil((end + contextSecs) * rate),
  );
  if (to <= from) return [];
  const result = await transcribeSamples(wave.samples.subarray(from, to), rate);
  const offset = from / rate;
  return tokensToWords(result.tokens ?? [], result.timestamps ?? [])
    .map((w) => ({ ...w, start: w.start + offset }))
    .filter((w) => w.start >= start && w.start < end);
}

/** A span as half-open sample-index bounds into the source waveform. */
interface SampleSpan {
  startSample: number;
  endSample: number;
}

/** A merged decode window: a contiguous span covering one or more voice activity spans. */
interface DecodeWindow {
  startSample: number;
  endSample: number;
  spans: SampleSpan[];
}

/**
 * Pack consecutive voice activity spans into decode windows of up to
 * MERGE_WINDOW_SEC. A span is appended to the current window while the window
 * stays within the cap; otherwise it opens a new window. Unlike core's
 * mergeSpans, which joins spans by the gap between them, this caps each
 * window's length and keeps the spans inside it. A single span longer than the cap (up to
 * TRANSCRIBE_VAD_OPTIONS.maxSpeechSecs) becomes its own window — still under Parakeet's ~400s limit.
 */
function packWindows(
  spans: readonly SampleSpan[],
  sampleRate: number,
): DecodeWindow[] {
  const maxSamples = MERGE_WINDOW_SEC * sampleRate;
  const windows: DecodeWindow[] = [];
  for (const span of spans) {
    const last = windows.at(-1);
    if (last && span.endSample - last.startSample <= maxSamples) {
      last.endSample = span.endSample;
      last.spans.push(span);
    } else {
      windows.push({
        startSample: span.startSample,
        endSample: span.endSample,
        spans: [span],
      });
    }
  }
  return windows;
}

/**
 * Distribute a window's recognized words (absolute timestamps, in time order)
 * back to the voice activity spans they fall in, yielding one SpeechRun per span
 * so the output still marks exactly where VAD cut. Each word is assigned to the
 * latest span whose start it has reached; a word landing in an inter-span
 * silence attaches to the preceding span. Spans with no words yield an empty
 * SpeechRun.
 */
function splitWordsIntoRuns(
  spans: readonly SampleSpan[],
  words: readonly Word[],
  sampleRate: number,
): SpeechRun[] {
  const segments: SpeechRun[] = spans.map((span) => ({
    start: span.startSample / sampleRate,
    end: span.endSample / sampleRate,
    words: [],
  }));
  let ri = 0;
  for (const word of words) {
    while (ri < segments.length - 1 && word.start >= segments[ri + 1]!.start)
      ri++;
    segments[ri]!.words.push(word);
  }
  return segments;
}

/** Map over items with a bounded number of in-flight async calls, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

async function transcribeSamples(
  samples: Float32Array,
  sampleRate: number,
): Promise<OfflineRecognizerResult> {
  const { recognizer } = getRecognizer();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  return await recognizer.decodeAsync(stream);
}

let _recognizer: OfflineRecognizer | null = null;

function getRecognizer() {
  const modelFiles = ensureModelFiles();
  if (_recognizer) return { recognizer: _recognizer, modelFiles };
  _recognizer = new sherpa_onnx.OfflineRecognizer({
    featConfig: { sampleRate: EXPECTED_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: modelFiles["encoder.int8.onnx"],
        decoder: modelFiles["decoder.int8.onnx"],
        joiner: modelFiles["joiner.int8.onnx"],
      },
      tokens: modelFiles["tokens.txt"],
      numThreads: 2,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
  });
  return { recognizer: _recognizer, modelFiles };
}

/**
 * Downloads (if missing) and loads the recognizer and VAD now, rather than on
 * the first transcribeAudio call. Loading the recognizer alone takes seconds.
 */
export function loadTranscriptionModels(): void {
  getRecognizer();
  loadVadModel();
}

export function ensureModelFiles() {
  const { files } = ensureDownloaded(TRANSCRIPTION_MODEL_SPEC);
  return files;
}

// NeMo Parakeet uses space-prefixed tokens (e.g. " Ask", "sk") where a leading
// space marks a word boundary. Punctuation tokens (e.g. ",") have no leading
// space and attach to the preceding word.
//
// Only the word's onset (its first token's timestamp) is kept: Parakeet reports
// no durations, so any per-word end would be an estimate. Word ends are instead
// derived from the run structure where needed — see Word in
// @open-minutes/core and deriveTimedWords in its transcription/align.ts.
export function tokensToWords(tokens: string[], timestamps: number[]): Word[] {
  const words: Word[] = [];
  let currentText = "";
  let currentStart = 0;

  const flush = () => {
    if (!currentText) return;
    words.push({ text: currentText, start: currentStart });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const ts = timestamps[i]!;
    // Also accept ▁ (U+2581) for models that use SentencePiece word-start marker.
    const isWordStart =
      token.startsWith(" ") || token.startsWith("▁") || i === 0;

    if (isWordStart) {
      flush();
      currentText = token.replace(/^[ ▁]+/, "");
      currentStart = ts;
    } else {
      currentText += token;
    }
  }
  flush();

  return words;
}

async function cli() {
  const audioPath = process.argv[2];
  if (!audioPath) {
    console.error("Usage: vpx transcribe.ts <path-to-audio-file>");
    process.exit(1);
  }
  const result = await transcribeAudio(audioPath);
  console.log("Transcription result:", JSON.stringify(result, null, 2));
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  cli();
}
