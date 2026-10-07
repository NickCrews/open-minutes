import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import type { Span } from "../activity";
import { centroid, normalize, type Vector } from "../vectors";
import { HOP_SEC, VoiceGrid } from "../voiceprints";

// Real voices on made-up turns, for testing what the voice analyses make of
// voiceprints without running the model. voice-samples.json holds a minute
// of real CAM++ window voiceprints for each of a few people in a golden
// meeting (written by sample-voices-cli.ts), and fakeGrid replays them over
// whatever turns a test lays out, so the analyses meet real voices: how
// alike one person's windows are, and how unlike two people's.

export const SAMPLES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "voice-samples.json",
);

/** voice-samples.json. */
export interface VoiceSamples {
  /** The golden meeting they were cut from. */
  source: string;
  people: {
    /** Their slug in the golden. */
    person: string;
    /** Runs of consecutive windows, {@link HOP_SEC} apart. */
    stretches: {
      /** Seconds into the meeting the first window starts. */
      start: number;
      /** Base64 of a signed byte per dimension per window. */
      windows: string;
    }[];
  }[];
}

export interface SampledVoice {
  /** Their slug in the golden. */
  person: string;
  /** Their windows' voiceprints, stretch after stretch. */
  windows: Vector[];
  /** Where in `windows` each stretch starts. */
  stretchStarts: number[];
}

let sampled: SampledVoice[] | null = null;

/** The sampled people, in the order {@link fakeGrid} hands them out. */
export function sampledVoices(): SampledVoice[] {
  sampled ??= (
    JSON.parse(readFileSync(SAMPLES_PATH, "utf8")) as VoiceSamples
  ).people.map(({ person, stretches }) => {
    const decoded = stretches.map((s) => decode(s.windows));
    let n = 0;
    return {
      person,
      windows: decoded.flat(),
      stretchStarts: decoded.map((d) => (n += d.length) - d.length),
    };
  });
  return sampled;
}

function decode(base64: string): Vector[] {
  const bytes = new Int8Array(Buffer.from(base64, "base64"));
  const out: Vector[] = [];
  for (let i = 0; i < bytes.length; i += N_DIMENSIONS)
    out.push(normalize(Float32Array.from(bytes.subarray(i, i + N_DIMENSIONS))));
  return out;
}

/** Who is talking when: the ground truth a fake meeting's audio is made of. */
export interface Turn extends Span {
  person: string;
}

/**
 * A {@link VoiceGrid} over made-up audio of `turns`, `durationSecs` long,
 * with speech wherever a turn is. The nth person to talk has the nth sampled
 * person's voice: their turns play that person's real stretches of speech
 * window by window, each turn carrying on where their last left off, as
 * after a pause, or starting the next stretch if too little of this one is
 * left (a turn longer than a stretch runs on into the next). A window across two turns is
 * the mix of both, weighted by how long each talks in it (real audio of two
 * people doesn't embed quite like that, but the analyses only need it to
 * match neither well). `voices` is each person's voice: the centroid of all
 * their windows. `embedded` counts the windows it was asked to embed.
 */
export function fakeGrid(
  turns: readonly Turn[],
  durationSecs: number,
  { cacheDir = null as string | null } = {},
) {
  const people = [...new Set(turns.map((t) => t.person))];
  const pool = sampledVoices();
  if (people.length > pool.length)
    throw new Error(`Only ${pool.length} sampled voices`);
  const voiceOf = new Map(people.map((p, i) => [p, pool[i]!]));
  const voices = new Map(
    people.map((p) => [p, centroid(voiceOf.get(p)!.windows)!]),
  );
  // Where in its person's windows each turn starts.
  const firstWindow = new Map<Turn, number>();
  const next = new Map<string, number>();
  for (const t of [...turns].sort((a, b) => a.start - b.start)) {
    const { windows, stretchStarts } = voiceOf.get(t.person)!;
    const n = Math.ceil((t.end - t.start) / HOP_SEC);
    let at = next.get(t.person) ?? 0;
    const i = stretchStarts.filter((s) => s <= at).length - 1;
    const end = stretchStarts[i + 1] ?? windows.length;
    if (at > stretchStarts[i]! && at + n > end) at = end % windows.length;
    firstWindow.set(t, at);
    next.set(t.person, (at + n) % windows.length);
  }

  const counter = { embedded: 0 };
  const grid = new VoiceGrid({
    durationSecs,
    speech: turns
      .map((t) => ({ start: t.start, end: t.end }))
      .sort((a, b) => a.start - b.start),
    cacheDir,
    embed: (start, end) => {
      counter.embedded++;
      const v = new Float32Array(N_DIMENSIONS);
      for (const t of turns) {
        const overlap = Math.min(end, t.end) - Math.max(start, t.start);
        if (overlap <= 0) continue;
        const own = voiceOf.get(t.person)!.windows;
        const k =
          firstWindow.get(t)! +
          Math.max(0, Math.round((start - t.start) / HOP_SEC));
        const window = own[k % own.length]!;
        for (let i = 0; i < v.length; i++) v[i]! += window[i]! * overlap;
      }
      return v;
    },
  });
  return { grid, voices, counter };
}
