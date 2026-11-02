import { createHash } from "node:crypto";
import { N_DIMENSIONS as VOICE_N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";

/**
 * A voiceprint per seeded person, keyed by slug. A person left out isn't
 * seeded, since every person needs one.
 */
export type Voiceprints = ReadonlyMap<string, ArrayLike<number>>;

/** A placeholder voiceprint for each of `slugs`. */
export function placeholderVoiceprints(slugs: readonly string[]): Voiceprints {
  return new Map(slugs.map((slug) => [slug, placeholderVoiceprint(slug)]));
}

/**
 * A deterministic unit vector per person: distinct, stable across reseeds,
 * and obviously not a real voiceprint.
 */
export function placeholderVoiceprint(slug: string): number[] {
  // mulberry32, seeded from a hash of the slug.
  let state = createHash("sha256").update(slug).digest().readUInt32LE(0);
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  const v = Array.from({ length: VOICE_N_DIMENSIONS }, next);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}
