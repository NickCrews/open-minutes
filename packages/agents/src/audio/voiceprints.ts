import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  extractEmbedding,
  getEmbeddingExtractor,
} from "@open-minutes/audio/embed";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { type Span, speechRuns } from "./activity";
import type { AudioMeeting } from "./meeting";
import { centroid, normalize, type Vector } from "./vectors";

// Voiceprints of a meeting's audio, on one fixed grid of short windows: a
// CAM++ voiceprint (the model diarization uses) for each 2 s window, one
// every 0.5 s. Every voice tool reads voiceprints off this grid, whether of
// a moment, a segment or everything under a label, so each window is
// embedded once, on first use, and cached beside the meeting's audio.

/** Seconds of audio per window. */
export const WINDOW_SEC = 2;
/** Seconds between window starts. */
export const HOP_SEC = 0.5;
/**
 * A window with less detected speech than this fraction is silent: it gets
 * no voiceprint, since mostly-quiet audio embeds as noise.
 */
export const MIN_SPEECH_FRACTION = 0.6;

/** Windows are cached in files of this many. */
const CHUNK_WINDOWS = 120;
/** Bump when the settings above or the model change, to drop old caches. */
const GRID_VERSION = 1;

/** One window of the grid. */
export interface VoiceWindow extends Span {
  /** Its L2-normalized voiceprint, or null if it is mostly silence. */
  voiceprint: Vector | null;
}

/** A voiceprint built from several windows. */
export interface Voiceprint {
  voiceprint: Vector;
  /** Seconds of audio it was built from. */
  sampledSecs: number;
}

export interface VoiceGridOptions {
  durationSecs: number;
  /** Speech runs (from VAD), in time order. */
  speech: readonly Span[];
  /** Where to cache windows' voiceprints; null to keep them in memory only. */
  cacheDir: string | null;
  /** The voiceprint of [start, end) of the audio, any scale. */
  embed: (start: number, end: number) => Vector;
}

// A window's state in a chunk file, stored as the first float of its row.
const UNKNOWN = 0;
const SILENT = 1;
const VOICED = 2;
const ROW = 1 + N_DIMENSIONS;

/**
 * The grid of window voiceprints over one meeting's audio. Window `k` covers
 * [k * HOP_SEC, k * HOP_SEC + WINDOW_SEC). A window is embedded only when a
 * caller first needs it, then cached in memory and (with a cacheDir) on disk.
 */
export class VoiceGrid {
  readonly speech: readonly Span[];
  readonly #options: VoiceGridOptions;
  readonly #chunks = new Map<number, Float32Array>();
  readonly #dirty = new Set<number>();
  /** Number of windows that fit in the audio. */
  readonly size: number;

  constructor(options: VoiceGridOptions) {
    this.#options = options;
    this.speech = options.speech;
    this.size = Math.max(
      0,
      Math.floor((options.durationSecs - WINDOW_SEC) / HOP_SEC) + 1,
    );
  }

  /** Every window starting in [from, to), in time order. */
  windows(from: number, to: number): VoiceWindow[] {
    const first = Math.max(0, Math.ceil(from / HOP_SEC - 1e-9));
    const last = Math.min(this.size, Math.ceil(to / HOP_SEC - 1e-9));
    const out: VoiceWindow[] = [];
    for (let k = first; k < last; k++)
      out.push({
        start: k * HOP_SEC,
        end: k * HOP_SEC + WINDOW_SEC,
        voiceprint: this.#window(k),
      });
    this.#flush();
    return out;
  }

  /**
   * The voiceprint of `spans` (eg a segment, or all of a label's): the
   * centroid of the voiced windows lying wholly inside one of them, at most
   * `maxWindows` of them, spread evenly through. Null if no voiced window
   * fits, as in a segment under 2 s.
   */
  voiceprint(spans: readonly Span[], maxWindows: number): Voiceprint | null {
    const found = new Set<number>();
    for (const span of spans) {
      const first = Math.max(0, Math.ceil(span.start / HOP_SEC - 1e-9));
      for (let k = first; k < this.size; k++) {
        if (k * HOP_SEC + WINDOW_SEC > span.end + 1e-9) break;
        if (this.#isSpeech(k)) found.add(k);
      }
    }
    const inside = [...found].sort((a, b) => a - b);
    const step = Math.max(1, inside.length / maxWindows);
    const picked: number[] = [];
    for (let i = 0; i < inside.length && picked.length < maxWindows; i += step)
      picked.push(inside[Math.floor(i)]!);
    const v = centroid(picked.map((k) => this.#window(k)!));
    this.#flush();
    // Windows overlap, so count the audio they cover, not windows times 2 s.
    let sampledSecs = 0;
    let coveredTo = -Infinity;
    for (const k of picked) {
      const start = Math.max(k * HOP_SEC, coveredTo);
      coveredTo = k * HOP_SEC + WINDOW_SEC;
      sampledSecs += coveredTo - start;
    }
    return v && { voiceprint: v, sampledSecs };
  }

  /** Whether window k is mostly speech: the windows that get a voiceprint. */
  #isSpeech(k: number): boolean {
    return (
      speechIn(this.speech, k * HOP_SEC, k * HOP_SEC + WINDOW_SEC) >=
      MIN_SPEECH_FRACTION * WINDOW_SEC
    );
  }

  #window(k: number): Vector | null {
    const chunkIndex = Math.floor(k / CHUNK_WINDOWS);
    const chunk = this.#chunk(chunkIndex);
    const row = (k % CHUNK_WINDOWS) * ROW;
    if (chunk[row] === UNKNOWN) {
      if (this.#isSpeech(k)) {
        const start = k * HOP_SEC;
        const v = normalize(this.#options.embed(start, start + WINDOW_SEC));
        if (v.length !== N_DIMENSIONS)
          throw new Error(
            `Expected ${N_DIMENSIONS}-dimensional voiceprints, got ${v.length}`,
          );
        chunk.set(v, row + 1);
        chunk[row] = VOICED;
      } else {
        chunk[row] = SILENT;
      }
      this.#dirty.add(chunkIndex);
    }
    return chunk[row] === VOICED ? chunk.slice(row + 1, row + ROW) : null;
  }

  #chunk(index: number): Float32Array {
    let chunk = this.#chunks.get(index);
    if (chunk) return chunk;
    const path = this.#path(index);
    if (path && existsSync(path)) {
      const bytes = readFileSync(path);
      chunk = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      );
    }
    if (chunk?.length !== CHUNK_WINDOWS * ROW)
      chunk = new Float32Array(CHUNK_WINDOWS * ROW);
    this.#chunks.set(index, chunk);
    return chunk;
  }

  #flush(): void {
    for (const index of this.#dirty) {
      const path = this.#path(index);
      if (!path) continue;
      mkdirSync(join(path, ".."), { recursive: true });
      // Write then rename, so another process never reads half a file.
      const tmp = `${path}.${process.pid}.tmp`;
      const chunk = this.#chunks.get(index)!;
      writeFileSync(tmp, new Uint8Array(chunk.buffer));
      renameSync(tmp, path);
    }
    this.#dirty.clear();
  }

  #path(index: number): string | null {
    const dir = this.#options.cacheDir;
    return dir && join(dir, `voiceprints-v${GRID_VERSION}`, `${index}.f32`);
  }
}

/** Seconds of `speech` (sorted, not overlapping) inside [from, to). */
export function speechIn(
  speech: readonly Span[],
  from: number,
  to: number,
): number {
  // The first run that ends after `from`, by binary search.
  let lo = 0;
  let hi = speech.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (speech[mid]!.end <= from) lo = mid + 1;
    else hi = mid;
  }
  let total = 0;
  for (let i = lo; i < speech.length && speech[i]!.start < to; i++)
    total += Math.min(speech[i]!.end, to) - Math.max(speech[i]!.start, from);
  return total;
}

const grids = new WeakMap<AudioMeeting, VoiceGrid>();

/** The voiceprint grid of a meeting's audio, cached beside it. */
export function voiceGrid(meeting: AudioMeeting): VoiceGrid {
  let grid = grids.get(meeting);
  if (!grid) {
    const wave = meeting.wave();
    grid = new VoiceGrid({
      durationSecs: wave.samples.length / wave.sampleRate,
      speech: speechRuns(meeting),
      cacheDir: meeting.cacheDir,
      embed: (start, end) =>
        extractEmbedding(getEmbeddingExtractor(), wave, start, end),
    });
    grids.set(meeting, grid);
  }
  return grid;
}
