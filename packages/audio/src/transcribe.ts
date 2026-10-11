/// <reference path="./sherpa-onnx-node.d.ts" />
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { ensureDownloaded, ModelSpec } from "./model.js";
import { EXPECTED_SAMPLE_RATE } from "./embed.js";
import { findHoles, splitHole } from "./holes.js";
import { detectSpeech, type Span } from "./speech-runs.js";
import { voteWords, type Disagreement } from "./vote.js";

import sherpa_onnx, {
  type OfflineRecognizer,
  type OfflineRecognizerResult,
  type Vad,
  type WaveForm,
} from "sherpa-onnx-node";
import type {
  SpeechSegment,
  TranscriptWord,
} from "@open-minutes/core/transcription";

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

// Silero VAD — finds speech/silence boundaries so we can chunk at silences.
export const VAD_MODEL_SPEC = {
  name: "silero_vad",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  single_file: true,
  files: {
    "silero_vad.onnx": true,
  },
} as const satisfies ModelSpec;

// How well this does is measured, and what the model does is written down, in
// packages/ingest/src/transcription-quality/ (see its README.md). Judge a change
// here by the north star there: word error rate and runtime.

// Both the recognizer and Silero VAD expect 16 kHz mono (EXPECTED_SAMPLE_RATE).
// @open-minutes/youtube's audio download produces that; we assert rather than
// resample.

// Parakeet TDT processes audio in a single pass. Its encoder uses a learned
// positional embedding (~5000 positions at the encoder's ~12.5 frames/sec output
// rate), so one pass tops out around ~400s of audio; beyond that ONNX throws a
// (catchable, non-fatal) broadcast error — verified empirically, it does NOT
// crash or OOM. Rather than slicing on fixed time boundaries — which cut words
// mid-utterance — we use Silero VAD to split the audio at silences. VAD picks the
// cut points (never mid-word); we then merge consecutive runs back into windows of
// up to MERGE_WINDOW_SEC (see below) so each decode gets real context, keeping
// every pass well under the ~400s cap. VAD_MAX_SPEECH_SEC force-splits any single
// run longer than 5 min (preferring the last silence) so no run alone exceeds it.
const VAD_THRESHOLD = 0.5; // speech-probability threshold
// Pause length that ends a speech run (the cut points). Exported because
// MAX_WORD_SEC (in core's transcription/align.ts) must stay below it — a
// derived word end that could span a pause this long would reach into the next
// speaker's turn.
export const VAD_MIN_SILENCE_SEC = 0.5;
const VAD_MIN_SPEECH_SEC = 0.25; // discard speech blips shorter than this
const VAD_MAX_SPEECH_SEC = 300; // force-split runs longer than this (stays under Parakeet's ~400s cap)
const VAD_WINDOW_SIZE = 512; // samples per Silero window at 16 kHz
const VAD_BUFFER_SEC = VAD_MAX_SPEECH_SEC + 5; // circular buffer must hold the longest run

// VAD splits at every silence, so a meeting yields ~1000 runs, many under 0.5s.
// Decoding each run alone starves Parakeet of context (hurting accuracy) and pays
// the per-decode overhead ~1000×. So we coalesce consecutive runs into windows of
// up to this many seconds and decode each in one pass — comfortably under the
// ~400s cap, but large enough to give the model real surrounding context. The
// window is a contiguous slice (inter-run silences included, so timestamps stay
// linear); a single run longer than this still becomes its own window (≤300s).
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
 * Transcribe audio into speech segments. Silero VAD splits the audio at silences
 * (never mid-word); consecutive runs are merged into windows of up to
 * MERGE_WINDOW_SEC that are each decoded in one pass (so the model gets context),
 * then each window's words are redistributed back to the VAD runs they fall in.
 * The result is one {@link SpeechSegment} per VAD run, with absolute word
 * timestamps, in time order. Returns [] for silence. Input must be 16 kHz mono.
 */
export async function transcribeAudio(
  audio: string | WaveForm,
  options: TranscribeOptions = {},
): Promise<SpeechSegment[]> {
  const wallStart = Date.now();
  const wave = ensureWaveAudio(audio);
  assertSampleRate(wave.sampleRate);
  const duration = wave.samples.length / wave.sampleRate;
  const { tracing } = options;

  const speechRuns = detectSpeechRuns(wave);
  const windows = mergeRuns(speechRuns, wave.sampleRate);
  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(
    `Transcribing ${typeof audio === "string" ? audio : "<waveform>"} (${duration.toFixed(1)}s) in ${windows.length} window(s) merged from ${speechRuns.length} VAD run(s)...`,
  );

  const windowSegments = await mapWithConcurrency(
    windows,
    TRANSCRIBE_CONCURRENCY,
    async (win, i): Promise<SpeechSegment[]> => {
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
      return splitWordsIntoRuns(win.runs, words, wave.sampleRate);
    },
  );

  const elapsed = (Date.now() - wallStart) / 1000;
  console.error(
    `Done: ${duration.toFixed(1)}s audio in ${elapsed.toFixed(1)}s (RTF=${(elapsed / duration).toFixed(2)})`,
  );

  return windowSegments.flat();
}

/**
 * Recognize exactly [start, end) of the waveform in one pass, with nothing
 * either side: the words, with absolute onsets. What the model hears in that
 * framing alone; transcribeRange is the better transcript of a range.
 */
export async function recognizeOnce(
  wave: WaveForm,
  start: number,
  end: number,
): Promise<TranscriptWord[]> {
  assertSampleRate(wave.sampleRate);
  const rate = wave.sampleRate;
  const from = Math.max(0, Math.round(start * rate));
  const to = Math.min(wave.samples.length, Math.round(end * rate));
  if (to <= from) return [];
  const result = await transcribeSamples(wave.samples.subarray(from, to), rate);
  const offset = from / rate;
  return tokensToWords(result.tokens ?? [], result.timestamps ?? []).map(
    (w) => ({ ...w, start: w.start + offset }),
  );
}

/**
 * How transcribeRange frames its decodes: seconds of audio decoded before and
 * after the range. Every framing changes a few percent of the words, so the
 * vote over these is right more often than any one of them. Each starts at
 * least 2 s out, as the model hears a word cut off at the edge of what it's
 * given poorly. Three decodes is where more stop paying: on hard clips of the
 * golden meetings, five were no better.
 */
export const RANGE_FRAMINGS = [
  { before: 2, after: 2 },
  { before: 2.75, after: 2.75 },
  { before: 3.5, after: 2 },
] as const;

/** Holes longer than this are re-decoded in pieces about this long. */
const HOLE_PIECE_SEC = 8;
/** Seconds of audio decoded either side of a hole, on the first try. */
const HOLE_CONTEXT_SEC = 1;
/** How many times to look for holes again after filling them. */
const HOLE_ROUNDS = 2;

export interface RangeTranscript {
  /** The words whose onsets fall in the range, with absolute onsets. */
  words: TranscriptWord[];
  /**
   * Where the decodes heard different words, and what each heard. The vote is
   * usually right, but where it isn't, the right reading is often among
   * these.
   */
  disagreements: Disagreement[];
}

/**
 * Transcribe one stretch of audio, as well as we can: the words whose onsets
 * fall in [start, end). Decodes the stretch once per RANGE_FRAMINGS and takes
 * the words most decodes agree on (see voteWords), then re-decodes on its own
 * any stretch of speech the result has no words for (see repairHoles). For a
 * closer look at a short range (under a few minutes); transcribeAudio is for
 * whole meetings.
 */
export async function transcribeRange(
  wave: WaveForm,
  start: number,
  end: number,
): Promise<RangeTranscript> {
  assertSampleRate(wave.sampleRate);
  const inRange = (ws: TranscriptWord[]) =>
    ws.filter((w) => w.start >= start && w.start < end);
  const decodes = await Promise.all(
    RANGE_FRAMINGS.map(async ({ before, after }) =>
      inRange(await recognizeOnce(wave, start - before, end + after)),
    ),
  );
  const vote = voteWords(decodes);
  const speech = speechIn(wave, start - 1, end + 1);
  const words = inRange(await repairHoles(wave, vote.words, speech));
  return { words, disagreements: vote.disagreements };
}

/**
 * `words` (in time order) with the holes in them filled: each stretch of
 * `speech` they have no words for (see findHoles) is decoded on its own, in
 * pieces of up to HOLE_PIECE_SEC, and the words heard there are added. A
 * piece still empty is tried again, framed a little wider, up to HOLE_ROUNDS
 * times.
 */
async function repairHoles(
  wave: WaveForm,
  words: readonly TranscriptWord[],
  speech: readonly Span[],
): Promise<TranscriptWord[]> {
  let out = [...words];
  for (let round = 0; round < HOLE_ROUNDS; round++) {
    const holes = findHoles(out, speech);
    if (holes.length === 0) break;
    const context = HOLE_CONTEXT_SEC + round * 0.37;
    const found = await mapWithConcurrency(
      holes,
      TRANSCRIBE_CONCURRENCY,
      async (hole) => {
        // Only words between the hole's neighbours, so none is heard twice.
        const after = out.find((w) => w.start >= hole.end)?.start ?? Infinity;
        const pieces = splitHole(hole, speech, HOLE_PIECE_SEC);
        const heard = await Promise.all(
          pieces.map((p) =>
            recognizeOnce(wave, p.start - context, p.end + context),
          ),
        );
        return heard.flatMap((ws, i) =>
          ws.filter(
            (w) =>
              w.start >= pieces[i]!.start - 0.5 &&
              w.start < pieces[i]!.end &&
              w.start < after - 0.15,
          ),
        );
      },
    );
    out = [...out, ...found.flat()].sort((a, b) => a.start - b.start);
  }
  return out;
}

/** Speech spans by VAD in [from, to) of the waveform, in absolute seconds. */
function speechIn(wave: WaveForm, from: number, to: number): Span[] {
  const rate = wave.sampleRate;
  const a = Math.max(0, Math.floor(from * rate));
  const b = Math.min(wave.samples.length, Math.ceil(to * rate));
  const offset = a / rate;
  return detectSpeech({
    sampleRate: rate,
    samples: wave.samples.subarray(a, b),
  }).map((s) => ({ start: s.start + offset, end: s.end + offset }));
}

/** A speech run as half-open sample-index bounds into the source waveform. */
interface SpeechRun {
  startSample: number;
  endSample: number;
}

/** A merged decode window: a contiguous span covering one or more VAD runs. */
interface SpeechWindow {
  startSample: number;
  endSample: number;
  runs: SpeechRun[];
}

/**
 * Coalesce consecutive VAD runs into windows of up to MERGE_WINDOW_SEC. A run is
 * appended to the current window while the window's total span stays within the
 * cap; otherwise it opens a new window. A single run longer than the cap (up to
 * VAD_MAX_SPEECH_SEC) becomes its own window — still under Parakeet's ~400s limit.
 */
function mergeRuns(
  runs: readonly SpeechRun[],
  sampleRate: number,
): SpeechWindow[] {
  const maxSamples = MERGE_WINDOW_SEC * sampleRate;
  const windows: SpeechWindow[] = [];
  for (const run of runs) {
    const last = windows.at(-1);
    if (last && run.endSample - last.startSample <= maxSamples) {
      last.endSample = run.endSample;
      last.runs.push(run);
    } else {
      windows.push({
        startSample: run.startSample,
        endSample: run.endSample,
        runs: [run],
      });
    }
  }
  return windows;
}

/**
 * Distribute a window's recognized words (absolute timestamps, in time order)
 * back to the VAD runs they fall in, yielding one SpeechSegment per run so the
 * output still marks exactly where VAD cut. Each word is assigned to the latest
 * run whose start it has reached; a word landing in an inter-run silence attaches
 * to the preceding run. Runs with no words yield an empty segment.
 */
function splitWordsIntoRuns(
  runs: readonly SpeechRun[],
  words: readonly TranscriptWord[],
  sampleRate: number,
): SpeechSegment[] {
  const segments: SpeechSegment[] = runs.map((r) => ({
    start: r.startSample / sampleRate,
    end: r.endSample / sampleRate,
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

/**
 * Run Silero VAD over the whole waveform, returning speech runs in time order.
 * We keep only the sample-index bounds, not vad.front()'s copied samples — those
 * are discarded immediately so we never duplicate the audio (see transcribeAudio,
 * which slices zero-copy views from the original waveform).
 */
function detectSpeechRuns(wave: WaveForm): SpeechRun[] {
  const vad = getVad();
  vad.reset();

  const runs: SpeechRun[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      runs.push({
        startSample: seg.start,
        endSample: seg.start + seg.samples.length,
      });
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

function ensureWaveAudio(audio: string | WaveForm): WaveForm {
  if (typeof audio === "string") {
    return sherpa_onnx.readWave(audio);
  }
  return audio;
}

function assertSampleRate(actual: number): void {
  if (actual !== EXPECTED_SAMPLE_RATE) {
    throw new Error(
      `Transcription expects ${EXPECTED_SAMPLE_RATE} Hz mono audio, got ${actual} Hz. ` +
        `Resample first (e.g. ffmpeg -ar 16000 -ac 1).`,
    );
  }
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

let _vad: Vad | null = null;

function getVad(): Vad {
  if (_vad) return _vad;
  const files = ensureDownloaded(VAD_MODEL_SPEC).files;
  _vad = new sherpa_onnx.Vad(
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
    VAD_BUFFER_SEC,
  );
  return _vad;
}

/**
 * Downloads (if missing) and loads the recognizer and VAD now, rather than on
 * the first transcribeAudio call. Loading the recognizer alone takes seconds.
 */
export function loadTranscriptionModels(): void {
  getRecognizer();
  getVad();
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
// derived from the run structure where needed — see TranscriptWord in
// @open-minutes/core and deriveTimedWords in its transcription/align.ts.
export function tokensToWords(
  tokens: string[],
  timestamps: number[],
): TranscriptWord[] {
  const words: TranscriptWord[] = [];
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
    console.error("Usage: tsx transcribe.ts <path-to-audio-file>");
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
