import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  chapterGenerationsTable,
  chaptersTable,
  jurisdictionsTable,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/db";
import type { DataState } from "@open-minutes/db/ensure";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { transcriptFingerprint } from "@open-minutes/core/transcript-fingerprint";
import { N_DIMENSIONS as VOICE_N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { TEST_DATA_ROOT, loadAllTestData, type TestData } from "../test-data";
import { mapSnapshot } from "./map";
import { advanceIdSequences } from "./sequences";

// The "dev" dataset `pnpm dev` seeds: the golden fixtures, plus the golden
// meetings' transcripts and people (which "golden" leaves out).
//
// Voiceprints are distinct deterministic placeholders, since real ones need
// ~600 MB of audio per meeting. Nearest-neighbor queries work, but recognition
// against dev data is meaningless.

// Bump when the seeder's behavior changes in a way the fixture files don't
// capture.
// 2: seeds chapters; 3: seeds meeting slugs; 4: bodies' meeting sources
// replace video_sources, and meetings are on sites
const DEV_SEED_VERSION = 4;

// Every table the dev seeder owns. Truncated together (children would cascade
// anyway); listing them keeps the footprint visible.
const DEV_TABLES = [
  chaptersTable,
  chapterGenerationsTable,
  segmentsTable,
  meetingsTable,
  peopleTable,
  bodiesTable,
  jurisdictionsTable,
];

const INSERT_CHUNK = 500;

/** The golden fixtures, meetings and people included. */
export function loadDevSnapshot(): TestData {
  return loadAllTestData(TEST_DATA_ROOT);
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
      throw new Error(`Meeting ${m.slug} has unknown body "${m.body_id}"`);
    const lastWord = m.segments.flatMap((s) => s.words).at(-1);
    return {
      id: i + 1,
      slug: m.slug,
      body_id: bodyId,
      site_kind: "youtube" as const,
      site_id: m.youtube_id,
      title: m.title,
      date: m.date,
      time: m.time,
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

  // One generation per meeting with a chapters.json, ids in meeting order.
  const chapterGenerations: (typeof chapterGenerationsTable.$inferInsert)[] =
    [];
  const chapters: (typeof chaptersTable.$inferInsert)[] = [];
  snapshot.meetings.forEach((m, i) => {
    if (!m.chapters) return;
    const generationId = chapterGenerations.length + 1;
    chapterGenerations.push({
      id: generationId,
      meeting_id: i + 1,
      ...m.chapters.generation,
      transcript_fingerprint: transcriptFingerprint(m.segments),
    });
    for (const c of m.chapters.chapters) {
      chapters.push({
        meeting_id: i + 1,
        generation_id: generationId,
        // Postgres reads a bare number as seconds.
        start_secs: `${c.start}`,
        end_secs: `${c.end}`,
        title: c.title,
        summary: c.summary,
        bullets: c.bullets,
      });
    }
  });

  return await db.transaction(async (tx) => {
    const tables = sql.join(
      DEV_TABLES.map((t) => sql`${t}`),
      sql.raw(", "),
    );
    await tx.execute(sql`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    await tx.insert(jurisdictionsTable).values(mapped.jurisdictions);
    await tx.insert(bodiesTable).values(mapped.bodies);
    await tx.insert(peopleTable).values(people);
    await tx.insert(meetingsTable).values(meetings);
    for (let i = 0; i < segments.length; i += INSERT_CHUNK) {
      await tx
        .insert(segmentsTable)
        .values(segments.slice(i, i + INSERT_CHUNK));
    }
    if (chapterGenerations.length) {
      await tx.insert(chapterGenerationsTable).values(chapterGenerations);
      await tx.insert(chaptersTable).values(chapters);
    }
    await advanceIdSequences(tx, DEV_TABLES);
    return {
      jurisdictions: mapped.jurisdictions.length,
      bodies: mapped.bodies.length,
      people: people.length,
      meetings: meetings.length,
      segments: segments.length,
      chapter_generations: chapterGenerations.length,
      chapters: chapters.length,
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
    await seedDevDatabase(db);
  },
};
