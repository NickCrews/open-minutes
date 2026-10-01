import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sherpa_onnx, {
  type OfflineSpeakerDiarization,
  type WaveForm,
} from "sherpa-onnx-node";

import { ensureDownloaded, type ModelSpec } from "./model.js";
import {
  assertSampleRate,
  computeSpeakerEmbeddings,
  cosineSimilarity,
  EMBEDDING_MODEL_SPEC,
  ensureWaveAudio,
  getEmbeddingExtractor,
  groupBySpeaker,
  NUM_THREADS,
  speakerCentroid,
} from "./embed.js";
import type { DiarizationTurn } from "@open-minutes/core/transcription";

// Ported from OpenWhispr's offline speaker-diarization path. This module owns
// segmentation (Tier A): anonymous, time-stamped speaker turns from diarizeAudio.
// The voiceprint machinery it leans on for the post-clustering merge lives in
// embed.ts (Tier B). Unlike OpenWhispr (a native binary + an ONNX worker),
// sherpa-onnx-node exposes both the diarizer and the embedding extractor
// in-process, so there's no subprocess and no worker_threads here.

// pyannote segmentation 3.0 — finds speaker boundaries / overlapping speech.
export const SEGMENTATION_MODEL_SPEC = {
  name: "sherpa-onnx-pyannote-segmentation-3-0",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
  files: {
    "model.onnx": true,
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
    .map((s) => ({ start: s.start, end: s.end, speakerNum: s.speaker }))
    .sort((a, b) => a.start - b.start);
  return mergeSpeakers(wave, rawTurns);
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
    const group = groupOf.get(t.speakerNum);
    if (group !== undefined) anchors.push({ mid: midpoint(t), group });
  }

  const groupForTurn = (t: DiarizationTurn): number => {
    const group = groupOf.get(t.speakerNum);
    if (group !== undefined) return group;
    if (anchors.length === 0) return t.speakerNum; // degenerate: no voiceprints at all
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
      speakerNum: renumber.get(groupForTurn(t))!,
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

function midpoint(t: DiarizationTurn): number {
  return (t.start + t.end) / 2;
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

async function cli() {
  const audioPath = process.argv[2];
  if (!audioPath) {
    console.error("Usage: tsx diarize.ts <path-to-16khz-mono-wav>");
    process.exit(1);
  }
  const turns = diarizeAudio(audioPath);
  const speakers = new Set(turns.map((t) => t.speakerNum));
  console.log(
    `Found ${speakers.size} speaker(s) across ${turns.length} turn(s).`,
  );
  const embeddings = computeSpeakerEmbeddings(audioPath, turns);
  for (const turn of turns) {
    console.log(
      `${turn.start.toFixed(2)} -- ${turn.end.toFixed(2)} speaker_${turn.speakerNum}`,
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
