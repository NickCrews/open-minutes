import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import type { Span } from "../activity";
import { normalize, type Vector } from "../vectors";
import { VoiceGrid } from "../voiceprints";

// Made-up voices, for testing what the voice tools make of voiceprints
// without running the model. Each person is a random direction in voiceprint
// space (random directions in 192 dimensions are nearly orthogonal, like two
// people's voiceprints), and a stretch of audio's voiceprint is the mix of
// the voices talking in it, weighted by how long each talks.

/** A deterministic pseudo-random number generator (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random unit vector, the same for the same seed. */
export function randomVoice(seed: number): Vector {
  const next = random(seed);
  const v = new Float32Array(N_DIMENSIONS);
  // Box-Muller: Gaussian coordinates give a direction uniform on the sphere.
  for (let i = 0; i < v.length; i++)
    v[i] =
      Math.sqrt(-2 * Math.log(next() || 1e-12)) *
      Math.cos(2 * Math.PI * next());
  return normalize(v);
}

/** Who is talking when: the ground truth a fake meeting's audio is made of. */
export interface Turn extends Span {
  person: string;
}

/**
 * A {@link VoiceGrid} over made-up audio of `turns`, `durationSecs` long:
 * speech wherever a turn is, and each window's voiceprint the mix of the
 * voices in it. `embedded` counts the windows it was asked to embed.
 */
export function fakeGrid(
  turns: readonly Turn[],
  durationSecs: number,
  { cacheDir = null as string | null, noise = 0.5, seed = 1 } = {},
) {
  const people = [...new Set(turns.map((t) => t.person))];
  const voices = new Map(
    people.map((p, i) => [p, randomVoice(seed * 1000 + i)]),
  );
  const jitter = random(seed);
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
        const voice = voices.get(t.person)!;
        for (let i = 0; i < v.length; i++) v[i]! += voice[i]! * overlap;
      }
      // Two windows of one person score about 0.8, as CAM++'s do.
      const n = normalize(v);
      for (let i = 0; i < v.length; i++)
        n[i]! += (noise * (jitter() - 0.5) * 2) / Math.sqrt(v.length / 3);
      return normalize(n);
    },
  });
  return { grid, voices, counter };
}
