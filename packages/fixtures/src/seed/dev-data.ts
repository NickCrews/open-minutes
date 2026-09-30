import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  jurisdictionsTable,
  meetingsTable,
  peopleTable,
  segmentsTable,
  videoSourcesTable,
} from "@open-minutes/db";
import type { DataState } from "@open-minutes/db/ensure";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { N_DIMENSIONS as VOICE_N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import {
  DEV_DATA_ROOT,
  TEST_DATA_ROOT,
  loadAllTestData,
  type TestData,
} from "../test-data";
import { mapSnapshot } from "./map";
import { advanceIdSequences } from "./sequences";

// The "dev" dataset: what `pnpm dev` puts in the playground so the web app
// looks and behaves realistically. It is the golden fixtures — including the
// golden meetings' full transcripts, speakers, and people, which the "golden"
// dataset (evals, benchmarks) leaves out — plus the extra, fictional fixtures
// in dev-data/, in the same format.
//
// Voiceprints are deterministic placeholders, not computed from audio: that
// would mean downloading ~600 MB of audio per meeting and running the
// embedding model on every seed. Every person gets a distinct vector, so
// nearest-neighbor queries work, but voice recognition against dev data is
// meaningless. Ingest real meetings (`om ingest`) for real voiceprints.

// Bump when the seeder's behavior changes in a way the fixture files don't
// capture.
const DEV_SEED_VERSION = 1;

// Every table the dev seeder owns. Truncated together (children would cascade
// anyway); listing them keeps the footprint visible.
const DEV_TABLES = [
  segmentsTable,
  meetingsTable,
  peopleTable,
  videoSourcesTable,
  bodiesTable,
  jurisdictionsTable,
];

const INSERT_CHUNK = 500;

/** Golden fixtures plus dev-data/ fixtures, as one snapshot. */
export function loadDevSnapshot(): TestData {
  const golden = loadAllTestData(TEST_DATA_ROOT);
  const extra = loadAllTestData(DEV_DATA_ROOT);
  const merged: TestData = {
    jurisdictions: [...golden.jurisdictions, ...extra.jurisdictions],
    bodies: [...golden.bodies, ...extra.bodies],
    people: [...golden.people, ...extra.people],
    meetings: [...golden.meetings, ...extra.meetings],
  };
  assertUnique(
    merged.jurisdictions.map((j) => j.id),
    "jurisdiction id",
  );
  assertUnique(
    merged.bodies.map((b) => b.id),
    "body id",
  );
  assertUnique(
    merged.people.map((p) => p.slug),
    "person slug",
  );
  assertUnique(
    merged.meetings.map((m) => m.youtube_id),
    "meeting youtube_id",
  );
  return merged;
}

function assertUnique(values: string[], what: string): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) {
      throw new Error(
        `Duplicate ${what} "${v}" across test-data/ and dev-data/.`,
      );
    }
    seen.add(v);
  }
}

/** Per-table count of rows inserted by a dev seed. */
export type DevSeedSummary = Record<string, number>;

/**
 * Replace every table the dev dataset covers with the dev snapshot, in one
 * transaction. Ids are assigned in snapshot order, so URLs like `/meetings/1`
 * stay stable across reseeds.
 */
export async function seedDevDatabase(db: DB): Promise<DevSeedSummary> {
  const snapshot = loadDevSnapshot();
  const mapped = mapSnapshot(snapshot);

  // People: everyone in people.jsonl, plus anyone a transcript identifies who
  // isn't listed (seeded nameless, the way ingestion creates them).
  const slugs = [...snapshot.people.map((p) => p.slug)];
  for (const meeting of snapshot.meetings) {
    for (const seg of meeting.segments) {
      if (
        seg.speaker.kind === "identified" &&
        !slugs.includes(seg.speaker.person)
      )
        slugs.push(seg.speaker.person);
    }
  }
  const personBySlug = new Map(snapshot.people.map((p) => [p.slug, p]));
  const personIdBySlug = new Map(slugs.map((slug, i) => [slug, i + 1]));
  const people = slugs.map((slug, i) => ({
    id: i + 1,
    slug,
    name: personBySlug.get(slug)?.name ?? null,
    bio: personBySlug.get(slug)?.bio ?? null,
    voice_embedding: placeholderVoiceprint(slug),
  }));

  const meetings = snapshot.meetings.map((m, i) => {
    const bodyId = mapped.bodyIdByKey.get(m.body_id);
    if (bodyId === undefined)
      throw new Error(
        `Meeting ${m.youtube_id} has unknown body "${m.body_id}"`,
      );
    const lastWord = m.segments.flatMap((s) => s.words).at(-1);
    return {
      id: i + 1,
      body_id: bodyId,
      youtube_id: m.youtube_id,
      title: m.title,
      start_time: m.start_time ? new Date(m.start_time) : null,
      duration_secs: lastWord
        ? sql`make_interval(secs => ${lastWord.start + LAST_WORD_DURATION_SEC})`
        : null,
    };
  });

  const segments = snapshot.meetings.flatMap((m, i) =>
    m.segments
      .filter((seg) => seg.words.length > 0)
      .map((seg) => ({
        meeting_id: i + 1,
        person_id:
          seg.speaker.kind === "identified"
            ? personIdBySlug.get(seg.speaker.person)!
            : null,
        speaker_number:
          seg.speaker.kind === "segmented" ? seg.speaker.cluster : null,
        words: seg.words,
      })),
  );

  return await db.transaction(async (tx) => {
    const tables = sql.join(
      DEV_TABLES.map((t) => sql`${t}`),
      sql.raw(", "),
    );
    await tx.execute(sql`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    await tx.insert(jurisdictionsTable).values(mapped.jurisdictions);
    await tx.insert(bodiesTable).values(mapped.bodies);
    if (mapped.videoSources.length)
      await tx.insert(videoSourcesTable).values(mapped.videoSources);
    await tx.insert(peopleTable).values(people);
    await tx.insert(meetingsTable).values(meetings);
    for (let i = 0; i < segments.length; i += INSERT_CHUNK) {
      await tx
        .insert(segmentsTable)
        .values(segments.slice(i, i + INSERT_CHUNK));
    }
    await advanceIdSequences(tx, DEV_TABLES);
    return {
      jurisdictions: mapped.jurisdictions.length,
      bodies: mapped.bodies.length,
      video_sources: mapped.videoSources.length,
      people: people.length,
      meetings: meetings.length,
      segments: segments.length,
    };
  });
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

/** Hash of every fixture file the dev dataset reads. */
function fixturesHash(): string {
  const hash = createHash("sha256").update(`v${DEV_SEED_VERSION}\n`);
  for (const root of [TEST_DATA_ROOT, DEV_DATA_ROOT]) {
    for (const file of fixtureFiles(root)) {
      hash.update(`${relative(root, file)}\0`);
      hash.update(readFileSync(file));
    }
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

/** Golden fixtures (with meetings) + dev-data/ extras: the dev playground. */
export const devData: DataState = {
  name: "dev",
  get fingerprint() {
    fingerprint ??= fixturesHash();
    return fingerprint;
  },
  apply: async (db) => {
    await seedDevDatabase(db);
  },
};
