import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sherpa_onnx, {
  type OfflineSpeakerDiarization,
  type SpeakerEmbeddingExtractor,
  type WaveForm,
} from "sherpa-onnx-node";

import { ensureDownloaded, type ModelSpec } from "./model.js";
import type { DiarizationTurn } from "@open-minutes/core/transcription";

// Ported from OpenWhispr's offline speaker-diarization path. Two layers:
//   - diarizeAudio():            anonymous, time-stamped speaker turns (Tier A).
//   - computeSpeakerEmbeddings(): one CAM++ voiceprint per speaker (Tier B), for
//                                 matching against known people downstream.
// Unlike OpenWhispr (a native binary + an ONNX worker), sherpa-onnx-node exposes
// both the diarizer and the embedding extractor in-process, so there's no
// subprocess and no worker_threads here.

// pyannote segmentation 3.0 — finds speaker boundaries / overlapping speech.
const SEGMENTATION_MODEL_SPEC = {
  name: "sherpa-onnx-pyannote-segmentation-3-0",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
  files: {
    "model.onnx": true,
  },
} as const satisfies ModelSpec;

// 3D-Speaker CAM++ (zh_en-common_advanced) — produces 192-dim voice embeddings.
// Used both by the diarizer internally (for clustering) and by us directly (for
// centroids + the post-clustering merge below). We deliberately use the
// "common_advanced" variant rather than en_voxceleb: on GBOS audio it separates
// speakers far more cleanly (different speakers ~0.1-0.25 cosine vs en_voxceleb's
// muddy 0.45-0.5), which is what makes both clustering and identify.ts reliable.
// NOTE: the release tag "speaker-recongition-models" is misspelled upstream;
// that misspelling is the correct, canonical URL.
const EMBEDDING_MODEL_SPEC = {
  name: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  single_file: true,
  files: {
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx": true,
  },
} as const satisfies ModelSpec;

// --- Tunable constants (values mirror OpenWhispr's offline path) ---

// Diarizer clustering. -1 lets the model auto-detect the speaker count; the
// threshold then controls how eagerly it splits (lower = more speakers). These
// are deliberately separate from the recognition thresholds in identify.ts.
const NUM_CLUSTERS = -1;
const CLUSTER_THRESHOLD = 0.55;
const MIN_DURATION_ON = 0.2; // ignore speech blips shorter than this (seconds)
const MIN_DURATION_OFF = 0.5; // ignore silences shorter than this when splitting

// Post-clustering merge. sherpa's agglomerative clustering over-splits on long
// recordings: one real speaker drifts into many sub-clusters as the meeting wears
// on (a 166-min meeting produced ~160 "speakers"). We re-merge any two clusters
// whose voiceprints are this similar. 0.5 matches identify.ts's recognition band
// and collapses the long tail without a crude fixed speaker cap. See
// DIARIZATION_FINDINGS.md for the data behind this value.
const MERGE_THRESHOLD = 0.5;

// Centroid construction. We embed a speaker's longest turns and average them.
const LONGEST_SEGMENTS = 3; // how many turns per speaker feed the centroid
const MIN_SEGMENT_SECONDS = 1.5; // turns shorter than this don't embed reliably
const MAX_EMBEDDING_SECONDS = 8; // cap audio fed to the embedder (use the tail)

const EXPECTED_SAMPLE_RATE = 16000;

// ONNX intra-op threads. The 166-min meeting is CPU-bound in sherpa's process();
// 4 roughly halves wall time vs 2 while leaving headroom on typical machines.
const NUM_THREADS = 4;

/**
 * Split audio into anonymous, time-stamped speaker turns. Turns are sorted by
 * start time and speakers are integer ids (0, 1, …), numbered by talk time
 * (speaker 0 talks most). Returns [] for silence.
 *
 * sherpa's raw clustering over-splits long meetings, so we re-merge clusters
 * whose voiceprints are too similar to be different people (see mergeSpeakers).
 */
export function diarizeAudio(audio: string | WaveForm): DiarizationTurn[] {
  const wave = ensureWaveAudio(audio);
  const diarizer = getDiarizer();
  assertSampleRate(wave.sampleRate, diarizer.sampleRate);

  const segments = diarizer.process(wave.samples);
  const rawTurns = segments
    .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }))
    .sort((a, b) => a.start - b.start);
  return mergeSpeakers(wave, rawTurns);
}

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

/**
 * Collapse sherpa's over-split clusters. Each raw cluster gets a voiceprint from
 * its longest turns; clusters whose voiceprints are within MERGE_THRESHOLD are
 * agglomeratively merged (average-linkage). Tiny clusters with no embeddable turn
 * ("orphans") are folded into whichever merged speaker is talking nearest in
 * time. Speakers are then renumbered 0..N by talk time. No fixed cap is applied.
 */
function mergeSpeakers(
  wave: WaveForm,
  turns: DiarizationTurn[],
): DiarizationTurn[] {
  if (turns.length === 0) return turns;
  const extractor = getEmbeddingExtractor();

  // 1. One voiceprint per raw cluster. Clusters whose turns are all too short to
  //    embed reliably get no voiceprint and are handled as orphans below.
  type Cluster = { ids: number[]; centroid: Float32Array; weight: number };
  const clusters: Cluster[] = [];
  for (const [speaker, speakerTurns] of groupBySpeaker(turns)) {
    const centroid = speakerCentroid(extractor, wave, speakerTurns);
    if (centroid) clusters.push({ ids: [speaker], centroid, weight: 1 });
  }

  // 2. Greedily merge the most-similar pair until none exceed the threshold.
  agglomerate(clusters, MERGE_THRESHOLD);

  // 3. Map each embeddable raw cluster to its merged group index.
  const groupOf = new Map<number, number>();
  clusters.forEach((c, gi) => c.ids.forEach((id) => groupOf.set(id, gi)));

  // 4. Anchors = midpoints of every turn whose speaker survived as a real group,
  //    used to place orphan turns by time. If nothing embedded (all-short audio),
  //    fall back to keeping raw speakers as their own groups.
  const anchors: { mid: number; group: number }[] = [];
  for (const t of turns) {
    const group = groupOf.get(t.speaker);
    if (group !== undefined) anchors.push({ mid: midpoint(t), group });
  }

  const groupForTurn = (t: DiarizationTurn): number => {
    const group = groupOf.get(t.speaker);
    if (group !== undefined) return group;
    if (anchors.length === 0) return t.speaker; // degenerate: no voiceprints at all
    return nearestGroup(midpoint(t), anchors);
  };

  // 5. Renumber groups to contiguous ids ordered by total talk time (0 = most).
  const talkTime = new Map<number, number>();
  for (const t of turns) {
    const group = groupForTurn(t);
    talkTime.set(group, (talkTime.get(group) ?? 0) + (t.end - t.start));
  }
  const renumber = new Map<number, number>();
  [...talkTime.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([group], i) => renumber.set(group, i));

  return turns
    .map((t) => ({
      start: t.start,
      end: t.end,
      speaker: renumber.get(groupForTurn(t))!,
    }))
    .sort((a, b) => a.start - b.start);
}

/** Greedy average-linkage agglomeration: merge the closest pair until all pairs are below `threshold`. Mutates `clusters` in place. */
function agglomerate(
  clusters: { ids: number[]; centroid: Float32Array; weight: number }[],
  threshold: number,
): void {
  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let bestSim = threshold;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = cosineSimilarity(
          clusters[i]!.centroid,
          clusters[j]!.centroid,
        );
        if (sim >= bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break;

    const a = clusters[bestI]!;
    const b = clusters[bestJ]!;
    const weight = a.weight + b.weight;
    const merged = new Float32Array(a.centroid.length);
    for (let k = 0; k < merged.length; k++) {
      merged[k] =
        (a.centroid[k]! * a.weight + b.centroid[k]! * b.weight) / weight;
    }
    a.centroid = merged;
    a.weight = weight;
    a.ids.push(...b.ids);
    clusters.splice(bestJ, 1);
  }
}

/** The group of the anchor turn nearest `mid` in time. */
function nearestGroup(
  mid: number,
  anchors: { mid: number; group: number }[],
): number {
  let best = anchors[0]!.group;
  let bestDist = Infinity;
  for (const a of anchors) {
    const dist = Math.abs(mid - a.mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = a.group;
    }
  }
  return best;
}

/** Voiceprint for a speaker: mean of their up-to-LONGEST_SEGMENTS longest embeddable turns, or null if none qualify. */
function speakerCentroid(
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
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

function midpoint(t: DiarizationTurn): number {
  return (t.start + t.end) / 2;
}

function groupBySpeaker(
  turns: DiarizationTurn[],
): Map<number, DiarizationTurn[]> {
  const bySpeaker = new Map<number, DiarizationTurn[]>();
  for (const turn of turns) {
    const list = bySpeaker.get(turn.speaker) ?? [];
    list.push(turn);
    bySpeaker.set(turn.speaker, list);
  }
  return bySpeaker;
}

function ensureWaveAudio(audio: string | WaveForm): WaveForm {
  return typeof audio === "string" ? sherpa_onnx.readWave(audio) : audio;
}

function assertSampleRate(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(
      `Diarization expects ${expected} Hz mono audio, got ${actual} Hz. ` +
        `Resample first (e.g. ffmpeg -ar 16000 -ac 1).`,
    );
  }
}

let _diarizer: OfflineSpeakerDiarization | null = null;

function getDiarizer(): OfflineSpeakerDiarization {
  if (_diarizer) return _diarizer;
  const seg = ensureDownloaded(SEGMENTATION_MODEL_SPEC).files;
  const emb = ensureDownloaded(EMBEDDING_MODEL_SPEC).files;
  _diarizer = new sherpa_onnx.OfflineSpeakerDiarization({
    segmentation: {
      pyannote: { model: seg["model.onnx"] },
      numThreads: NUM_THREADS,
      provider: "cpu",
    },
    embedding: {
      model: emb["3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"],
      numThreads: NUM_THREADS,
      provider: "cpu",
    },
    clustering: { numClusters: NUM_CLUSTERS, threshold: CLUSTER_THRESHOLD },
    minDurationOn: MIN_DURATION_ON,
    minDurationOff: MIN_DURATION_OFF,
  });
  return _diarizer;
}

let _extractor: SpeakerEmbeddingExtractor | null = null;

function getEmbeddingExtractor(): SpeakerEmbeddingExtractor {
  if (_extractor) return _extractor;
  const emb = ensureDownloaded(EMBEDDING_MODEL_SPEC).files;
  _extractor = new sherpa_onnx.SpeakerEmbeddingExtractor({
    model: emb["3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"],
    numThreads: NUM_THREADS,
    provider: "cpu",
  });
  return _extractor;
}

async function cli() {
  const audioPath = process.argv[2];
  if (!audioPath) {
    console.error("Usage: tsx diarize.ts <path-to-16khz-mono-wav>");
    process.exit(1);
  }
  const turns = diarizeAudio(audioPath);
  const speakers = new Set(turns.map((t) => t.speaker));
  console.log(
    `Found ${speakers.size} speaker(s) across ${turns.length} turn(s).`,
  );
  const embeddings = computeSpeakerEmbeddings(audioPath, turns);
  for (const turn of turns) {
    console.log(
      `${turn.start.toFixed(2)} -- ${turn.end.toFixed(2)} speaker_${turn.speaker}`,
    );
  }
  console.log(`Built ${embeddings.size} speaker embedding(s).`);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  cli();
}
