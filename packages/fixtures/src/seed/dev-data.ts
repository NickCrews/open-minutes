import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { DataState } from "@open-minutes/db/ensure";
import { N_DIMENSIONS as VOICE_N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { TEST_DATA_ROOT, loadAllTestData, type TestData } from "../test-data";
import { goldenData } from "./golden-data";
import {
  GOLDEN_MEETINGS_SEED_VERSION,
  type Voiceprints,
  seedGoldenMeetings,
} from "./golden-meetings";

// The "dev" dataset `pnpm dev` seeds: the golden rows, plus every golden
// meeting with its transcript, chapters and people, and everyone in
// people.jsonl.
//
// Voiceprints are distinct deterministic placeholders, since real ones need
// ~600 MB of audio per meeting. Nearest-neighbor queries work, but recognition
// against dev data is meaningless.

// Bump when the dev dataset's behavior changes in a way the fixture files and
// GOLDEN_MEETINGS_SEED_VERSION don't capture.
const DEV_SEED_VERSION = 6;

/** The golden fixtures, meetings and people included. */
export function loadDevSnapshot(): TestData {
  return loadAllTestData(TEST_DATA_ROOT);
}

const placeholderVoiceprints: Voiceprints = async (slugs) =>
  new Map(slugs.map((slug) => [slug, placeholderVoiceprint(slug)]));

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

/** Hash of every fixture file the dev dataset reads. */
function fixturesHash(): string {
  const hash = createHash("sha256").update(
    `v${DEV_SEED_VERSION}.${GOLDEN_MEETINGS_SEED_VERSION}\n${goldenData.fingerprint}\n`,
  );
  for (const file of fixtureFiles(TEST_DATA_ROOT)) {
    hash.update(`${relative(TEST_DATA_ROOT, file)}\0`);
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 12);
}

/** .jsonl, meeting.json, and *.psv files, sorted; skips generated/cached audio. */
function fixtureFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || entry.includes(".gen.")) continue;
    if (stat.isDirectory()) out.push(...fixtureFiles(path));
    else if (/\.(jsonl|json|psv)$/.test(entry)) out.push(path);
  }
  return out;
}

let fingerprint: string | undefined;

/** Golden fixtures with their meetings and people: the dev playground. */
export const devData: DataState = {
  name: "dev",
  get fingerprint() {
    fingerprint ??= fixturesHash();
    return fingerprint;
  },
  apply: async (db) => {
    await goldenData.apply(db);
    const snapshot = loadDevSnapshot();
    await seedGoldenMeetings(db, snapshot.meetings, {
      registry: snapshot.people,
      people: "registry",
      voiceprints: placeholderVoiceprints,
    });
  },
};
