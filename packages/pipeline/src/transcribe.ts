import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDownloaded, ModelSpec } from "./model.js";

import sherpa_onnx, { type OfflineRecognizer, type OfflineRecognizerResult } from "sherpa-onnx-node";
import type { TranscriptSegment, TranscriptWord } from "./types.ts";

const MODEL_SPEC = {
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
    "test_wavs": {
      "en.wav": true,
      "zh.wav": true,
    },
  },
} as const satisfies ModelSpec

// Parakeet TDT is a transducer model that processes audio as a single pass.
// Its encoder uses a learned positional embedding with 2500 positions; at the
// encoder's ~12.5 frames/sec output rate that caps a single pass at ~200s of
// audio before ONNX broadcasts the positional embedding against a longer
// sequence and crashes. We chunk well under that limit and adjust timestamps
// by the chunk offset.
export const CHUNK_SEC = 2 * 60;

export type TraceEvent = {
  chunkIndex: number;
  chunkStart: number;
  chunkEnd: number;
  wallStartMs: number;
  wallEndMs: number;
};

const traceEvents: TraceEvent[] = [];

function isTracingEnabled(): boolean {
  return process.env.TRANSCRIBE_TRACE === "1";
}

export function getTraceEvents(): readonly TraceEvent[] {
  return traceEvents;
}

export function resetTrace(): void {
  traceEvents.length = 0;
}

export async function transcribeAudio(
  audio: string | sherpa_onnx.WaveForm,
  chunkSec: number = CHUNK_SEC,
): Promise<TranscriptSegment[]> {
  const wallStart = Date.now();
  const wave = ensureWaveAudio(audio);
  const duration = wave.samples.length / wave.sampleRate;
  const nChunks = Math.max(1, Math.ceil(duration / chunkSec));
  const tracing = isTracingEnabled();

  console.log(
    `Transcribing ${typeof audio === "string" ? audio : "<waveform>"} (${duration.toFixed(1)}s) in ${nChunks} chunk(s) of up to ${chunkSec}s...`,
  );

  const tasks = Array.from({ length: nChunks }, async (_, i): Promise<TranscriptSegment | null> => {
    const chunkStart = i * chunkSec;
    const chunkEnd = Math.min(chunkStart + chunkSec, duration);
    const startIdx = Math.round(chunkStart * wave.sampleRate);
    const endIdx = Math.round(chunkEnd * wave.sampleRate);
    const chunk = wave.samples.subarray(startIdx, endIdx);

    if (nChunks > 1) {
      console.log(`  chunk ${i + 1}/${nChunks}: ${chunkStart.toFixed(0)}s – ${chunkEnd.toFixed(0)}s`);
    }

    const traceStart = tracing ? Date.now() : 0;
    const result = await transcribeSamples(chunk, wave.sampleRate);
    if (tracing) {
      traceEvents.push({
        chunkIndex: i,
        chunkStart,
        chunkEnd,
        wallStartMs: traceStart,
        wallEndMs: Date.now(),
      });
    }

    const text = result.text.trim();
    if (!text) return null;

    const words = tokensToWords(result.tokens ?? [], result.timestamps ?? []).map((w) => ({
      ...w,
      start: w.start + chunkStart,
      end: w.end + chunkStart,
    }));

    return {
      speaker: { type: "unlabeled" },
      words,
    };
  });

  const results = await Promise.all(tasks);
  const segments = results.filter((s): s is TranscriptSegment => s !== null);

  const elapsed = (Date.now() - wallStart) / 1000;
  console.log(`Done: ${duration.toFixed(1)}s audio in ${elapsed.toFixed(1)}s (RTF=${(elapsed / duration).toFixed(2)})`);

  return segments;
}

function ensureWaveAudio(audio: string | sherpa_onnx.WaveForm): sherpa_onnx.WaveForm {
  if (typeof audio === "string") {
    return sherpa_onnx.readWave(audio);
  }
  return audio;
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
    featConfig: { sampleRate: 16000, featureDim: 80 },
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

export function ensureModelFiles() {
  const { files } = ensureDownloaded(MODEL_SPEC);
  return files;
}

// NeMo Parakeet uses space-prefixed tokens (e.g. " Ask", "sk") where a leading
// space marks a word boundary. Punctuation tokens (e.g. ",") have no leading
// space and attach to the preceding word.
function tokensToWords(tokens: string[], timestamps: number[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let currentText = "";
  let currentStart = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const ts = timestamps[i]!;
    // Also accept ▁ (U+2581) for models that use SentencePiece word-start marker.
    const isWordStart = token.startsWith(" ") || token.startsWith("▁") || i === 0;

    if (isWordStart && currentText) {
      words.push({ text: currentText, start: currentStart, end: ts });
      currentText = token.replace(/^[ ▁]+/, "");
      currentStart = ts;
    } else if (isWordStart) {
      currentText = token.replace(/^[ ▁]+/, "");
      currentStart = ts;
    } else {
      currentText += token;
    }
  }

  if (currentText) {
    words.push({ text: currentText, start: currentStart, end: timestamps.at(-1) ?? currentStart });
  }

  return words.filter((w) => w.text.length > 0);
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
