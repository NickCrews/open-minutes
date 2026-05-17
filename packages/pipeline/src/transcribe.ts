import { join, resolve, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import sherpa_onnx, { type OfflineRecognizer, type OfflineRecognizerResult } from "sherpa-onnx-node";
import type { TranscriptSegment, TranscriptWord } from "./types.ts";

const HERE = new URL(".", import.meta.url);
const MODEL_DIR = join(HERE.pathname, "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");
const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2";

let _recognizer: OfflineRecognizer | null = null;

export function getRecognizer(): OfflineRecognizer {
  if (_recognizer) return _recognizer;
  ensureModelFiles(MODEL_DIR);
  _recognizer = new sherpa_onnx.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(MODEL_DIR, "encoder.int8.onnx"),
        decoder: join(MODEL_DIR, "decoder.int8.onnx"),
        joiner: join(MODEL_DIR, "joiner.int8.onnx"),
      },
      tokens: join(MODEL_DIR, "tokens.txt"),
      numThreads: 2,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
  });
  return _recognizer;
}

export function transcribeSamples(
  samples: Float32Array,
  sampleRate: number,
): OfflineRecognizerResult {
  const recognizer = getRecognizer();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream);
}

// NeMo Parakeet uses space-prefixed tokens (e.g. " Ask", "sk") where a leading
// space marks a word boundary. Punctuation tokens (e.g. ",") have no leading
// space and attach to the preceding word.
export function tokensToWords(tokens: string[], timestamps: number[]): TranscriptWord[] {
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

// Parakeet TDT is a transducer model that processes audio as a single pass.
// Very long files (~3 hrs) can hit memory limits or produce degraded output.
// We split into fixed-size chunks and adjust timestamps by the chunk offset.
// 30-minute chunks are well within the model's reliable range on typical hardware.
export const CHUNK_SEC = 30 * 60;

export async function transcribeAudio(
  audioPath: string,
  chunkSec: number = CHUNK_SEC,
): Promise<TranscriptSegment[]> {
  const wallStart = Date.now();
  const wave = sherpa_onnx.readWave(audioPath);
  const duration = wave.samples.length / wave.sampleRate;
  const nChunks = Math.max(1, Math.ceil(duration / chunkSec));

  console.log(
    `Transcribing ${audioPath} (${duration.toFixed(1)}s) in ${nChunks} chunk(s) of up to ${chunkSec}s...`,
  );

  const segments: TranscriptSegment[] = [];

  for (let i = 0; i < nChunks; i++) {
    const chunkStart = i * chunkSec;
    const chunkEnd = Math.min(chunkStart + chunkSec, duration);
    const startIdx = Math.round(chunkStart * wave.sampleRate);
    const endIdx = Math.round(chunkEnd * wave.sampleRate);
    const chunk = wave.samples.subarray(startIdx, endIdx);

    if (nChunks > 1) {
      console.log(`  chunk ${i + 1}/${nChunks}: ${chunkStart.toFixed(0)}s – ${chunkEnd.toFixed(0)}s`);
    }

    const result = transcribeSamples(chunk, wave.sampleRate);
    const text = result.text.trim();
    if (!text) continue;

    const words = tokensToWords(result.tokens ?? [], result.timestamps ?? []).map((w) => ({
      ...w,
      start: w.start + chunkStart,
      end: w.end + chunkStart,
    }));

    segments.push({
      text,
      start: words[0]?.start ?? chunkStart,
      end: words.at(-1)?.end ?? chunkEnd,
      words,
    });
  }

  const elapsed = (Date.now() - wallStart) / 1000;
  console.log(`Done: ${duration.toFixed(1)}s audio in ${elapsed.toFixed(1)}s (RTF=${(elapsed / duration).toFixed(2)})`);

  return segments;
}

function ensureModelFiles(downloadDir: string) {
  if (existsSync(downloadDir)) return;
  console.log(`Downloading model files from ${MODEL_URL} to ${downloadDir}...`);
  mkdirSync(downloadDir, { recursive: true });
  execSync(`curl -L "${MODEL_URL}" | tar -xj -C "${dirname(downloadDir)}"`, {
    stdio: "inherit",
  });
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
