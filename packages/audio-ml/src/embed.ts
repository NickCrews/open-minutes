/// <reference path="./sherpa-onnx-node.d.ts" />
import sherpa_onnx, { type SpeakerEmbeddingExtractor } from "sherpa-onnx-node";
import { ensureWaveForm, type WaveForm } from "@open-minutes/codecs";

import { EMBEDDING_MODEL_SPEC } from "./embed-model.js";
import { ensureDownloaded } from "./model.js";
import { type AudioInput, assertSampleRate, prepareInput } from "./input.js";
import type { Span } from "@open-minutes/core/span";
import type { DiarizationTurn } from "@open-minutes/core/transcription";
import type { SpanWithEmbedding } from "@open-minutes/core/voice_embeddings";

// Speaker-embedding toolkit (Tier B): one CAM++ voiceprint per speaker, for
// matching against known people downstream. diarize.ts also depends on these
// primitives — its post-clustering merge collapses over-split clusters by
// comparing their voiceprints (see mergeSpeakers there).

export { EMBEDDING_MODEL_SPEC };

// Centroid construction. We embed a speaker's longest turns and average them.
const LONGEST_SEGMENTS = 3; // how many turns per speaker feed the centroid
const MIN_SEGMENT_SECONDS = 1.5; // turns shorter than this don't embed reliably
const MAX_EMBEDDING_SECONDS = 8; // cap audio fed to the embedder (use the tail)

// ONNX intra-op threads. The 166-min meeting is CPU-bound in sherpa's process();
// 4 roughly halves wall time vs 2 while leaving headroom on typical machines.
export const NUM_THREADS = 4;

/**
 * One CAM++ embedding per span of `spans`, of the audio in it, in the same
 * order. Spans are embedded as given, however long or short: under about
 * 1.5 s, the vector is unreliable. Pass `slidingWindows` from
 * `@open-minutes/core/span` for embeddings along the audio, and `centroid`
 * from `@open-minutes/core/voice_embeddings` for the mean of those inside a
 * span.
 *
 * Throws a RangeError on a span that is empty or not inside the file, and the
 * signal's reason if it is aborted.
 */
export async function embedSpans(
  audio: AudioInput,
  spans: readonly Span[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<SpanWithEmbedding[]> {
  const { wave, duration } = await prepareInput(audio, { signal, span: [] });
  // Times that land a hair past the end of the file, as float sums can.
  const eps = 1e-6;
  for (const { start, end } of spans) {
    if (!(start >= 0 && end <= duration + eps && end > start)) {
      throw new RangeError(
        `Span ${start}–${end} s is empty or not inside the audio (0–${duration} s).`,
      );
    }
  }
  const extractor = getEmbeddingExtractor();
  const out: SpanWithEmbedding[] = [];
  for (const { start, end } of spans) {
    signal?.throwIfAborted();
    const vector = embed(extractor, wave, start, end);
    out.push({ start, end, vector });
  }
  return out;
}

/**
 * Build one voiceprint per speaker: for each speaker take their longest turns
 * (≥ MIN_SEGMENT_SECONDS, up to LONGEST_SEGMENTS), embed each, and average into
 * a centroid. Speakers with no qualifying turn are omitted.
 */
export async function computeSpeakerEmbeddings(
  audio: string | WaveForm,
  turns: DiarizationTurn[],
): Promise<Map<number, Float32Array>> {
  const wave = await ensureWaveForm(audio);
  const extractor = getEmbeddingExtractor();
  assertSampleRate(wave.sampleRate);

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
  return embed(extractor, wave, clampedStart, endSec);
}

/** The embedding of samples [startSec, endSec) of `wave`. */
function embed(
  extractor: SpeakerEmbeddingExtractor,
  wave: WaveForm,
  startSec: number,
  endSec: number,
): Float32Array {
  const startIdx = Math.floor(startSec * wave.sampleRate);
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
    const list = bySpeaker.get(turn.speakerNumber) ?? [];
    list.push(turn);
    bySpeaker.set(turn.speakerNumber, list);
  }
  return bySpeaker;
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
