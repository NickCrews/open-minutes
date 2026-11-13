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
import {
  alignHypotheses,
  normalizeToken,
  type SpeechRun,
} from "@open-minutes/core/transcription";
import type { Span } from "@open-minutes/core/span";

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

// Parakeet TDT decodes a window of audio in a single pass. Its encoder uses a
// learned positional embedding (~5000 positions at the encoder's ~12.5
// frames/sec output rate), so one pass tops out around ~400s of audio; beyond
// that ONNX throws a (catchable, non-fatal) broadcast error. Rather than slicing
// on fixed time boundaries, which cut words mid-utterance, we use Silero VAD to
// split the audio at silences, and decode windows of consecutive voice activity
// spans, cut only at silences.
//
// One pass over the audio is not enough. How Parakeet hears a stretch depends
// on the whole window around it, down to where the window's 80 ms frames fall,
// and now and then it decodes seconds of clear speech as nothing (see
// transcription-quality/parakeet.characterization.test.ts). So transcribeAudio
// decodes the audio TRANSCRIBE_PASSES times, each pass with its windows cut at
// different silences and its frames offset, lines up the passes' words in each
// voice activity span (alignHypotheses) and votes on each word.

/**
 * The VAD settings transcribeAudio cuts the audio with. `MAX_WORD_SEC` in core
 * must stay below `minSilenceSecs`, so a derived word end can't reach across a
 * pause into the next speaker's turn. `maxSpeechSecs` force-splits any span
 * longer than 5 min (preferring the last silence), so no window exceeds
 * Parakeet's ~400 s cap.
 */
export const TRANSCRIBE_VAD_OPTIONS = {
  minSilenceSecs: 0.5,
  minSpeechSecs: 0.25,
  maxSpeechSecs: 300,
} as const satisfies VoiceActivityOptions;

/** How many times transcribeAudio decodes the audio. */
export const TRANSCRIBE_PASSES = 3;

/**
 * The period of each pass's window grid. A window holds the voice activity
 * spans that start in one cell of its pass's grid, so it runs from a silence
 * to a silence and is about this long, or longer when its last span is. Each
 * pass's grid is offset from the last by WINDOW_SEC / TRANSCRIBE_PASSES, so a
 * stretch near one pass's window edge is well inside another's.
 */
export const WINDOW_SEC = 45;

/**
 * The encoder's frame length. Each pass starts its windows earlier by another
 * FRAME_SEC / TRANSCRIBE_PASSES, so the passes' frames fall at different
 * places.
 */
const FRAME_SEC = 0.08;

/**
 * The probability that a voted word is right, by how many passes heard that
 * word (`agree`) and how many heard any word in its slot (`heard`), indexed
 * [agree - 1][heard - 1]. Measured for TRANSCRIBE_PASSES passes on the golden
 * meetings, after cleanSpeechRuns, as the fraction of such words that match
 * the golden.
 */
const CONFIDENCE: readonly (readonly number[])[] = [
  [0.5, 0.5, 0.5],
  [NaN, 0.8, 0.8],
  [NaN, NaN, 0.95],
];

/** Words less likely than this to be right are left out of the transcript. */
const MIN_CONFIDENCE = 0.5;

// Decode windows in parallel, but bounded: each concurrent decode holds a chunk
// of native onnxruntime memory, so an unbounded pool blows up RAM. Cap
// concurrency to keep peak memory in check while still using multiple cores.
const TRANSCRIBE_CONCURRENCY = Math.max(1, Math.min(4, availableParallelism()));

export interface TranscribeWindowEvent {
  pass: number;
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
 * Transcribe audio into speech runs: one {@link SpeechRun} per voice activity
 * span Silero VAD finds, with absolute word onsets, in time order. Each word
 * carries its confidence. Returns [] for silence. Input must be 16 kHz mono.
 */
export async function transcribeAudio(
  audio: AudioInput,
  options: TranscribeOptions = {},
): Promise<SpeechRun[]> {
  const wallStart = Date.now();
  const wave = await ensureWaveForm(audio);
  assertSampleRate(wave.sampleRate);
  const duration = wave.samples.length / wave.sampleRate;

  const spans = await detectVoiceActivity(wave, TRANSCRIBE_VAD_OPTIONS);
  const passes = Array.from({ length: TRANSCRIBE_PASSES }, (_, p) =>
    planWindows(spans, {
      windowSec: WINDOW_SEC,
      gridOffsetSec: (p * WINDOW_SEC) / TRANSCRIBE_PASSES,
      leadSec: (p * FRAME_SEC) / TRANSCRIBE_PASSES,
    }),
  );
  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(
    `Transcribing ${typeof audio === "string" ? audio : "<waveform>"} (${duration.toFixed(1)}s): ${spans.length} voice activity span(s), ${TRANSCRIBE_PASSES} passes of ${passes[0]!.length} window(s)...`,
  );
  const heard = await decodePasses(wave, spans, passes, options.tracing);
  const runs = spans.map((span, i) => ({
    start: span.start,
    end: span.end,
    words: voteWords(heard.map((pass) => pass[i]!)),
  }));

  const elapsed = (Date.now() - wallStart) / 1000;
  console.error(
    `Done: ${duration.toFixed(1)}s audio in ${elapsed.toFixed(1)}s (RTF=${(elapsed / duration).toFixed(2)})`,
  );
  return runs;
}

/** A word one pass heard, and how far its onset is from its window's nearer edge. */
export interface PassWord extends Word {
  edgeSecs: number;
}

/** A stretch of audio decoded in one pass: voice activity spans `first` to `last`, inclusive. */
export interface DecodeWindow {
  start: number;
  end: number;
  first: number;
  last: number;
}

/**
 * One pass's decode windows over `spans`. A window holds the consecutive
 * spans whose starts fall in one cell of a grid of period `windowSec`,
 * offset by `gridOffsetSec`, and starts `leadSec` before its first span.
 */
export function planWindows(
  spans: readonly Span[],
  {
    windowSec,
    gridOffsetSec,
    leadSec,
  }: { windowSec: number; gridOffsetSec: number; leadSec: number },
): DecodeWindow[] {
  const windows: DecodeWindow[] = [];
  let cell = NaN;
  spans.forEach((span, i) => {
    const c = Math.floor((span.start - gridOffsetSec) / windowSec);
    const last = windows.at(-1);
    if (last && c === cell) {
      last.end = span.end;
      last.last = i;
    } else {
      windows.push({
        start: Math.max(0, span.start - leadSec),
        end: span.end,
        first: i,
        last: i,
      });
    }
    cell = c;
  });
  return windows;
}

/**
 * Decode every pass's windows, and hand each window's words to the spans
 * they fall in: [pass][span] → words, in time order. A word goes to the
 * latest span of its window whose start it has reached; one in a silence
 * between spans goes to the span before.
 */
export async function decodePasses(
  wave: WaveForm,
  spans: readonly Span[],
  passes: readonly (readonly DecodeWindow[])[],
  tracing?: TranscribeTracing,
): Promise<PassWord[][][]> {
  const heard = passes.map(() => spans.map((): PassWord[] => []));
  const jobs = passes.flatMap((windows, pass) =>
    windows.map((win, windowIndex) => ({ win, pass, windowIndex })),
  );
  const rate = wave.sampleRate;
  await mapWithConcurrency(
    jobs,
    TRANSCRIBE_CONCURRENCY,
    async ({ win, pass, windowIndex }) => {
      const from = Math.round(win.start * rate);
      const to = Math.min(wave.samples.length, Math.round(win.end * rate));
      const event = {
        pass,
        windowIndex,
        windowStart: from / rate,
        windowEnd: to / rate,
        wallStartMs: Date.now(),
      };
      tracing?.onWindowStart?.(event);
      // A view into the waveform, not a copy: every pass covers all of it.
      const result = await transcribeSamples(
        wave.samples.subarray(from, to),
        rate,
      );
      tracing?.onWindowEnd?.({ ...event, wallEndMs: Date.now() });

      let s = win.first;
      for (const w of tokensToWords(
        result.tokens ?? [],
        result.timestamps ?? [],
      )) {
        const start = w.start + from / rate;
        while (s < win.last && start >= spans[s + 1]!.start) s++;
        heard[pass]![s]!.push({
          text: w.text,
          start,
          edgeSecs: Math.min(start - from / rate, to / rate - start),
        });
      }
    },
  );
  return heard;
}

/** A voted word, how many passes heard it, and how many heard any word in its place. */
export interface Vote {
  word: PassWord;
  agree: number;
  heard: number;
}

/**
 * Vote on several passes' words for the same audio. In each slot of
 * {@link alignHypotheses}, the word most passes heard wins, ties going to
 * the one heard farthest from a window edge, where the recognizer does best.
 * The winner takes the text of that farthest copy and the mean onset of all
 * its copies. A slot wins a word even when most passes heard nothing there:
 * the recognizer skips speech far more often than it invents it, and
 * {@link CONFIDENCE} says how often such a word is right.
 */
export function vote(passes: readonly (readonly PassWord[])[]): Vote[] {
  return alignHypotheses(passes).map((slot) => {
    const groups = new Map<string, PassWord[]>();
    for (const w of slot) {
      if (!w) continue;
      const key = normalizeToken(w.text);
      groups.set(key, [...(groups.get(key) ?? []), w]);
    }
    const farthest = (ws: PassWord[]) =>
      ws.reduce((a, b) => (b.edgeSecs > a.edgeSecs ? b : a));
    let best: PassWord[] = [];
    for (const g of groups.values())
      if (
        g.length > best.length ||
        (g.length === best.length &&
          farthest(g).edgeSecs > farthest(best).edgeSecs)
      )
        best = g;
    const rep = farthest(best);
    return {
      word: {
        text: rep.text,
        start: best.reduce((s, w) => s + w.start, 0) / best.length,
        edgeSecs: rep.edgeSecs,
      },
      agree: best.length,
      heard: slot.filter((w) => w !== null).length,
    };
  });
}

/**
 * The words of {@link vote} that are at least {@link MIN_CONFIDENCE} likely
 * to be right, with their confidence. Assumes TRANSCRIBE_PASSES passes.
 */
export function voteWords(passes: readonly (readonly PassWord[])[]): Word[] {
  const words: Word[] = [];
  for (const { word, agree, heard } of vote(passes)) {
    const confidence = CONFIDENCE[agree - 1]![heard - 1]!;
    if (confidence < MIN_CONFIDENCE) continue;
    // Mean onsets can step back a little where neighbouring slots were
    // heard by different passes; keep them in order.
    const start = Math.max(word.start, words.at(-1)?.start ?? -Infinity);
    words.push({ text: word.text, start, confidence });
  }
  return words;
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
// derived where needed — see Word in @open-minutes/core and deriveTimedWords in
// its transcription/align.ts.
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
