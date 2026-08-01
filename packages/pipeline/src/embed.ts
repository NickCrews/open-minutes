import sherpa_onnx, {
  type SpeakerEmbeddingExtractor,
  type WaveForm,
} from "sherpa-onnx-node";

import { ensureDownloaded, type ModelSpec } from "./model.js";
import type { DiarizationTurn } from "@open-minutes/core/transcription";

// Speaker-embedding toolkit (Tier B): one CAM++ voiceprint per speaker, for
// matching against known people downstream. diarize.ts also depends on these
// primitives — its post-clustering merge collapses over-split clusters by
// comparing their voiceprints (see mergeSpeakers there).

// 3D-Speaker CAM++ (zh_en-common_advanced) — produces 192-dim voice embeddings.
// Used both by the diarizer internally (for clustering) and by us directly (for
// centroids + diarize.ts's post-clustering merge). We deliberately use the
// "common_advanced" variant rather than en_voxceleb: on GBOS audio it separates
// speakers far more cleanly (different speakers ~0.1-0.25 cosine vs en_voxceleb's
// muddy 0.45-0.5), which is what makes both clustering and identify.ts reliable.
// NOTE: the release tag "speaker-recongition-models" is misspelled upstream;
// that misspelling is the correct, canonical URL.
export const EMBEDDING_MODEL_SPEC = {
  name: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  single_file: true,
  files: {
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx": true,
  },
} as const satisfies ModelSpec;

// Centroid construction. We embed a speaker's longest turns and average them.
const LONGEST_SEGMENTS = 3; // how many turns per speaker feed the centroid
const MIN_SEGMENT_SECONDS = 1.5; // turns shorter than this don't embed reliably
const MAX_EMBEDDING_SECONDS = 8; // cap audio fed to the embedder (use the tail)

export const EXPECTED_SAMPLE_RATE = 16000;

// ONNX intra-op threads. The 166-min meeting is CPU-bound in sherpa's process();
// 4 roughly halves wall time vs 2 while leaving headroom on typical machines.
export const NUM_THREADS = 4;

/**
 * Build one voiceprint per speaker: for each speaker take their longest turns
 * (≥ MIN_SEGMENT_SECONDS, up to LONGEST_SEGMENTS), embed each, and average into
 * a centroid. Speakers with no qualifying turn are omitted.
 */
export function computeSpeakerEmbeddings(
  audio: string | WaveForm,
  turns: DiarizationTurn[],
): Map<number, Float32Array> {
  const wave = ensureWaveAudio(audio);
  const extractor = getEmbeddingExtractor();
  assertSampleRate(wave.sampleRate, EXPECTED_SAMPLE_RATE);

  const centroids = new Map<number, Float32Array>();
  for (const [speaker, speakerTurns] of groupBySpeaker(turns)) {
    const centroid = speakerCentroid(extractor, wave, speakerTurns);
    if (centroid) centroids.set(speaker, centroid);
  }
  return centroids;
}

/** Voiceprint for a speaker: mean of their up-to-LONGEST_SEGMENTS longest embeddable turns, or null if none qualify. */
export function speakerCentroid(
  extractor: SpeakerEmbeddingExtractor,
  wave: WaveForm,
  turns: DiarizationTurn[],
): Float32Array | null {
  const longest = turns
    .filter((t) => t.end - t.start >= MIN_SEGMENT_SECONDS)
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, LONGEST_SEGMENTS);
  if (longest.length === 0) return null;

  const embeddings = longest.map((t) =>
    extractEmbedding(extractor, wave, t.start, t.end),
  );
  return computeCentroid(embeddings, extractor.dim);
}

function extractEmbedding(
  extractor: SpeakerEmbeddingExtractor,
  wave: WaveForm,
  startSec: number,
  endSec: number,
): Float32Array {
  // Cap to the last MAX_EMBEDDING_SECONDS of the turn (long turns gain nothing
  // from more audio and cost more to embed).
  const clampedStart = Math.max(startSec, endSec - MAX_EMBEDDING_SECONDS);
  const startIdx = Math.floor(clampedStart * wave.sampleRate);
  const endIdx = Math.floor(endSec * wave.sampleRate);
  const samples = wave.samples.subarray(startIdx, endIdx);

  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
  stream.inputFinished();
  return extractor.compute(stream);
}

/** Element-wise mean of N equal-length embeddings. */
function computeCentroid(
  embeddings: Float32Array[],
  dim: number,
): Float32Array {
  const centroid = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) centroid[i]! += emb[i]!;
  }
  for (let i = 0; i < dim; i++) centroid[i]! /= embeddings.length;
  return centroid;
}

/** Cosine similarity of two (not necessarily normalized) vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function groupBySpeaker(
  turns: DiarizationTurn[],
): Map<number, DiarizationTurn[]> {
  const bySpeaker = new Map<number, DiarizationTurn[]>();
  for (const turn of turns) {
    const list = bySpeaker.get(turn.speakerNum) ?? [];
    list.push(turn);
    bySpeaker.set(turn.speakerNum, list);
  }
  return bySpeaker;
}

export function ensureWaveAudio(audio: string | WaveForm): WaveForm {
  return typeof audio === "string" ? sherpa_onnx.readWave(audio) : audio;
}

export function assertSampleRate(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(
      `Speaker analysis expects ${expected} Hz mono audio, got ${actual} Hz. ` +
        `Resample first (e.g. ffmpeg -ar 16000 -ac 1).`,
    );
  }
}

let _extractor: SpeakerEmbeddingExtractor | null = null;

export function getEmbeddingExtractor(): SpeakerEmbeddingExtractor {
  if (_extractor) return _extractor;
  const emb = ensureDownloaded(EMBEDDING_MODEL_SPEC).files;
  _extractor = new sherpa_onnx.SpeakerEmbeddingExtractor({
    model: emb["3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"],
    numThreads: NUM_THREADS,
    provider: "cpu",
  });
  return _extractor;
}
