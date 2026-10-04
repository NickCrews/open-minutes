import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEmbeddingExtractor } from "@open-minutes/audio/embed";
import type { WaveForm } from "@open-minutes/audio/wav";
import { clip, type Span, speechRuns, totalSecs } from "./activity";
import type { LabeledSegment, AudioMeeting } from "./meeting";

// How a meeting's voices change over time. The audio is cut into short
// overlapping windows, and each gets a CAM++ voiceprint, the same model the
// pipeline uses to diarize and recognize speakers. Two windows of one person
// score high cosine similarity (~0.6-0.8), two people low (~0.1-0.3), so a
// drop between neighbouring windows marks a change of voice, and comparing a
// window with each label's voiceprint says who it sounds like.

/** Seconds of audio per voiceprint window. */
export const WINDOW_SEC = 2;
/** Seconds between window starts. */
export const HOP_SEC = 0.5;
/** Windows with less detected speech than this get no voiceprint. */
const MIN_SPEECH_FRACTION = 0.6;
/** The timeline is computed and cached in chunks of this many seconds. */
const CHUNK_SEC = 60;
const WINDOWS_PER_CHUNK = CHUNK_SEC / HOP_SEC;
/** Bump to invalidate cached timelines when the settings above change. */
const TIMELINE_VERSION = 1;

/** One window's voiceprint (L2-normalized), or null where nobody's talking. */
export interface VoiceWindow {
  start: number;
  end: number;
  embedding: Float32Array | null;
}

/**
 * The voiceprint windows starting in [from, to). Computed on first use
 * (about 1 s of compute per minute of audio) and cached beside the audio.
 */
export function voiceWindows(
  meeting: AudioMeeting,
  from: number,
  to: number,
): VoiceWindow[] {
  const runs = speechRuns(meeting);
  const out: VoiceWindow[] = [];
  const first = Math.floor(Math.max(0, from) / CHUNK_SEC);
  const last = Math.floor(to / CHUNK_SEC);
  for (let chunk = first; chunk <= last; chunk++) {
    const embeddings = chunkEmbeddings(meeting, runs, chunk);
    if (!embeddings) break; // past the end of the audio
    embeddings.forEach((embedding, k) => {
      const start = chunk * CHUNK_SEC + k * HOP_SEC;
      if (start >= from && start < to)
        out.push({ start, end: start + WINDOW_SEC, embedding });
    });
  }
  return out;
}

function chunkEmbeddings(
  meeting: AudioMeeting,
  runs: readonly Span[],
  chunk: number,
): (Float32Array | null)[] | null {
  const dir = join(meeting.cacheDir, `voice-timeline-v${TIMELINE_VERSION}`);
  const path = join(dir, `${chunk}.f32`);
  const wave = meeting.wave();
  const duration = wave.samples.length / wave.sampleRate;
  if (chunk * CHUNK_SEC >= duration) return null;

  const extractor = getEmbeddingExtractor();
  const dim = extractor.dim;
  if (existsSync(path)) {
    const flat = new Float32Array(readFileSync(path).buffer.slice(0));
    return Array.from({ length: flat.length / dim }, (_, k) => {
      const e = flat.subarray(k * dim, (k + 1) * dim);
      return Number.isNaN(e[0]) ? null : e;
    });
  }

  const embeddings: (Float32Array | null)[] = [];
  for (let k = 0; k < WINDOWS_PER_CHUNK; k++) {
    const start = chunk * CHUNK_SEC + k * HOP_SEC;
    const end = start + WINDOW_SEC;
    if (end > duration) break;
    const speech = totalSecs(clip(runs, start, end)) / WINDOW_SEC;
    embeddings.push(
      speech >= MIN_SPEECH_FRACTION ? embed(wave, start, end) : null,
    );
  }
  const flat = new Float32Array(embeddings.length * dim).fill(NaN);
  embeddings.forEach((e, k) => e && flat.set(e, k * dim));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, Buffer.from(flat.buffer));
  return embeddings;
}

/** The L2-normalized CAM++ voiceprint of [start, end). */
export function embed(
  wave: WaveForm,
  start: number,
  end: number,
): Float32Array {
  const extractor = getEmbeddingExtractor();
  const stream = extractor.createStream();
  stream.acceptWaveform({
    sampleRate: wave.sampleRate,
    samples: wave.samples.subarray(
      Math.floor(start * wave.sampleRate),
      Math.floor(end * wave.sampleRate),
    ),
  });
  stream.inputFinished();
  return normalize(extractor.compute(stream));
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Cosine similarity of two L2-normalized vectors. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** The normalized mean of normalized vectors; null for none. */
export function centroid(
  vectors: readonly Float32Array[],
): Float32Array | null {
  if (vectors.length === 0) return null;
  const sum = new Float32Array(vectors[0]!.length);
  for (const v of vectors) for (let i = 0; i < v.length; i++) sum[i]! += v[i]!;
  return normalize(sum);
}

/** The voiceprints of the windows lying wholly inside `span`. */
export function windowsInside(
  windows: readonly VoiceWindow[],
  span: Span,
): Float32Array[] {
  return windows
    .filter((w) => w.embedding && w.start >= span.start && w.end <= span.end)
    .map((w) => w.embedding!);
}

/** The voiceprint of a span: the centroid of its windows, or null if too short or quiet. */
export function spanVoiceprint(
  meeting: AudioMeeting,
  span: Span,
): Float32Array | null {
  return centroid(
    windowsInside(voiceWindows(meeting, span.start, span.end), span),
  );
}

/** Most windows sampled per label to build its voiceprint. */
const MAX_LABEL_WINDOWS = 60;

export interface LabelVoice {
  label: string;
  voiceprint: Float32Array;
  /** Seconds of the label's segments the voiceprint was sampled from. */
  sampledSecs: number;
}

/**
 * One voiceprint per speaker label in the transcript, from windows sampled
 * evenly across that label's segments. A label that covers two people gets a
 * voiceprint between them, matching neither well; `audit_speaker` finds such
 * labels. Labels with no clean 2 s of speech get none. Each label's
 * voiceprint is cached beside the audio, keyed by its segments' times, so
 * editing one label recomputes only that one.
 */
export function labelVoices(
  meeting: AudioMeeting,
  options: { exclude?: (seg: LabeledSegment) => boolean } = {},
): LabelVoice[] {
  const byLabel = new Map<string, LabeledSegment[]>();
  for (const seg of meeting.segments) {
    if (options.exclude?.(seg)) continue;
    byLabel.set(seg.label, [...(byLabel.get(seg.label) ?? []), seg]);
  }
  return [...byLabel]
    .map(([label, segments]) => labelVoice(meeting, label, segments))
    .filter((v): v is LabelVoice => v !== null);
}

const LABEL_VOICES_VERSION = 1;

function labelVoice(
  meeting: AudioMeeting,
  label: string,
  segments: readonly LabeledSegment[],
): LabelVoice | null {
  const key = createHash("sha1")
    .update(label)
    .update(segments.map((s) => `${s.start}-${s.end}`).join(","))
    .digest("hex");
  const dir = join(meeting.cacheDir, `label-voices-v${LABEL_VOICES_VERSION}`);
  const path = join(dir, `${key}.json`);
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8")) as {
      voiceprint: number[] | null;
      sampledSecs: number;
    };
    return cached.voiceprint
      ? {
          label,
          voiceprint: Float32Array.from(cached.voiceprint),
          sampledSecs: cached.sampledSecs,
        }
      : null;
  }

  // Candidate windows: back to back inside each segment, mostly speech.
  const runs = speechRuns(meeting);
  const candidates: Span[] = [];
  for (const seg of segments) {
    for (let t = seg.start; t + WINDOW_SEC <= seg.end; t += WINDOW_SEC) {
      const span = { start: t, end: t + WINDOW_SEC };
      if (
        totalSecs(clip(runs, span.start, span.end)) / WINDOW_SEC >=
        MIN_SPEECH_FRACTION
      )
        candidates.push(span);
    }
  }
  const step = Math.max(1, candidates.length / MAX_LABEL_WINDOWS);
  const picked: Span[] = [];
  for (let i = 0; i < candidates.length; i += step)
    picked.push(candidates[Math.floor(i)]!);
  const wave = meeting.wave();
  const voiceprint = centroid(picked.map((s) => embed(wave, s.start, s.end)));
  const sampledSecs = picked.length * WINDOW_SEC;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      voiceprint: voiceprint && Array.from(voiceprint),
      sampledSecs,
    }),
  );
  return voiceprint && { label, voiceprint, sampledSecs };
}

export interface RankedVoice {
  label: string;
  similarity: number;
}

/** `voices` ranked by similarity to `voiceprint`, best first. */
export function rankVoices(
  voiceprint: Float32Array,
  voices: readonly LabelVoice[],
): RankedVoice[] {
  return voices
    .map((v) => ({
      label: v.label,
      similarity: similarity(voiceprint, v.voiceprint),
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * How alike the voice just before and just after each window boundary is:
 * the similarity of the window ending at t with the one starting at t. Low
 * values are candidate changes of speaker. Null where either side is quiet.
 */
export function continuity(
  windows: readonly VoiceWindow[],
): { at: number; similarity: number | null }[] {
  const lag = Math.round(WINDOW_SEC / HOP_SEC);
  const out: { at: number; similarity: number | null }[] = [];
  for (let k = lag; k < windows.length; k++) {
    const a = windows[k - lag]!.embedding;
    const b = windows[k]!.embedding;
    out.push({
      at: windows[k]!.start,
      similarity: a && b ? similarity(a, b) : null,
    });
  }
  return out;
}

/**
 * Likely changes of voice: local minima of {@link continuity} below
 * `threshold`, at least `minGapSec` apart.
 */
export function changePoints(
  windows: readonly VoiceWindow[],
  threshold: number,
  minGapSec = 1.5,
): { at: number; similarity: number }[] {
  const scores = continuity(windows);
  const minima: { at: number; similarity: number }[] = [];
  scores.forEach((s, i) => {
    if (s.similarity === null || s.similarity >= threshold) return;
    const prev = scores[i - 1]?.similarity ?? Infinity;
    const next = scores[i + 1]?.similarity ?? Infinity;
    // Strict on the left, so a flat bottom counts once, where it starts.
    if (s.similarity < prev && s.similarity <= next)
      minima.push({ at: s.at, similarity: s.similarity });
  });
  // Keep the deepest of minima closer than minGapSec.
  const kept: { at: number; similarity: number }[] = [];
  for (const m of [...minima].sort((a, b) => a.similarity - b.similarity)) {
    if (kept.every((k) => Math.abs(k.at - m.at) >= minGapSec)) kept.push(m);
  }
  return kept.sort((a, b) => a.at - b.at);
}

/**
 * Split voiceprints into two groups by 2-means on cosine similarity,
 * weighted. Returns each item's group (0 or 1) and the two centroids; group 0
 * is the heavier. Deterministic: seeded with the heaviest item and the item
 * least like it.
 */
export function twoMeans(
  items: readonly { voiceprint: Float32Array; weight: number }[],
): { groups: number[]; centroids: [Float32Array, Float32Array] } | null {
  if (items.length < 2) return null;
  const heaviest = items.reduce((a, b) => (b.weight > a.weight ? b : a));
  const farthest = items.reduce((a, b) =>
    similarity(b.voiceprint, heaviest.voiceprint) <
    similarity(a.voiceprint, heaviest.voiceprint)
      ? b
      : a,
  );
  let centroids: [Float32Array, Float32Array] = [
    heaviest.voiceprint,
    farthest.voiceprint,
  ];
  let groups: number[] = [];
  for (let iter = 0; iter < 20; iter++) {
    const next = items.map((it) =>
      similarity(it.voiceprint, centroids[0]) >=
      similarity(it.voiceprint, centroids[1])
        ? 0
        : 1,
    );
    if (next.every((g, i) => g === groups[i])) break;
    groups = next;
    const weighted = (g: number) => {
      const sum = new Float32Array(centroids[0].length);
      for (const [i, it] of items.entries())
        if (groups[i] === g)
          for (let d = 0; d < sum.length; d++)
            sum[d]! += it.voiceprint[d]! * it.weight;
      return normalize(sum);
    };
    if (!groups.includes(1) || !groups.includes(0)) break;
    centroids = [weighted(0), weighted(1)];
  }
  const weightOf = (g: number) =>
    items.reduce((n, it, i) => n + (groups[i] === g ? it.weight : 0), 0);
  if (weightOf(1) > weightOf(0)) {
    groups = groups.map((g) => 1 - g);
    centroids = [centroids[1], centroids[0]];
  }
  return { groups, centroids };
}

/** Most windows sampled per segment to build its voiceprint. */
const MAX_SEGMENT_WINDOWS = 4;
const SEGMENT_VOICES_VERSION = 1;

/**
 * A voiceprint for every segment with a clean 2 s of speech, from up to
 * {@link MAX_SEGMENT_WINDOWS} windows spread across it. Cached beside the
 * audio by each segment's times, so editing a segment recomputes only it.
 */
export function segmentVoices(
  meeting: AudioMeeting,
): Map<number, Float32Array> {
  const dir = join(
    meeting.cacheDir,
    `segment-voices-v${SEGMENT_VOICES_VERSION}`,
  );
  const path = join(dir, "voiceprints.json");
  const cache: Record<string, number[] | null> = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : {};
  const runs = speechRuns(meeting);
  const out = new Map<number, Float32Array>();
  let computed = 0;
  for (const seg of meeting.segments) {
    const key = `${seg.start}-${seg.end}`;
    if (!(key in cache)) {
      if (computed === 0)
        console.error(`Voiceprinting ${meeting.ref}'s segments...`);
      cache[key] = segmentVoiceprint(meeting, runs, seg);
      computed++;
    }
    const v = cache[key];
    if (v) out.set(seg.id, Float32Array.from(v));
  }
  if (computed > 0) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  }
  return out;
}

function segmentVoiceprint(
  meeting: AudioMeeting,
  runs: readonly Span[],
  seg: Span,
): number[] | null {
  const candidates: Span[] = [];
  for (let t = seg.start; t + WINDOW_SEC <= seg.end; t += HOP_SEC) {
    const speech = totalSecs(clip(runs, t, t + WINDOW_SEC)) / WINDOW_SEC;
    if (speech >= MIN_SPEECH_FRACTION)
      candidates.push({ start: t, end: t + WINDOW_SEC });
  }
  if (candidates.length === 0) return null;
  const step = Math.max(1, candidates.length / MAX_SEGMENT_WINDOWS);
  const wave = meeting.wave();
  const picked: Float32Array[] = [];
  for (let i = 0; i < candidates.length; i += step) {
    const s = candidates[Math.floor(i)]!;
    picked.push(embed(wave, s.start, s.end));
  }
  return Array.from(centroid(picked)!);
}
