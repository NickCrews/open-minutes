import { sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  chapterGenerationsTable,
  chaptersTable,
  jurisdictionsTable,
  meetingBodiesTable,
  meetingsTable,
  peopleTable,
  recordingBodiesTable,
  recordingsTable,
  segmentsTable,
} from "@open-minutes/db";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { transcriptFingerprint } from "@open-minutes/core/transcript-fingerprint";
import {
  getMeetingData,
  loadBodies,
  loadJurisdictions,
  loadPeople,
  loadRecordings,
} from "@open-minutes/fixtures/test-data";
import { bodyRows, meetingBodyIds } from "./map";
import { advanceIdSequences } from "./sequences";
import type { DatasetSpec } from "./spec";
import { placeholderVoiceprints } from "./voiceprints";

/**
 * Bump when seedDataset's behavior changes in a way the specs and test data
 * don't capture. Every dataset's fingerprint includes it.
 */
export const SEED_VERSION = 2;

/** Per-table count of rows inserted by a seed. */
export type SeedSummary = Record<string, number>;

// Every table a dataset owns, truncated together. Not meeting_bodies or
// recording_bodies, which have no id sequence for advanceIdSequences, and go
// with their meetings and recordings.
const SEEDED_TABLES = [
  chaptersTable,
  chapterGenerationsTable,
  segmentsTable,
  meetingsTable,
  recordingsTable,
  peopleTable,
  bodiesTable,
  jurisdictionsTable,
];

const INSERT_CHUNK = 500;

/**
 * Replace every table the dataset covers with the rows `spec` declares, in one
 * transaction. Ids are assigned in order (recordings in recordings.jsonl
 * order, meetings in `spec.meetings` order, people in people.jsonl order, then
 * speakers in order of appearance), so URLs
 * like `/meetings/1` stay stable across reseeds.
 *
 * Every person needs a voiceprint, so a speaker with too little speech to
 * embed isn't seeded, and their segments are seeded with no person.
 */
export async function seedDataset(
  db: DB,
  spec: DatasetSpec,
): Promise<SeedSummary> {
  const { jurisdictions, bodies, bodyIdBySlug } = bodyRows(
    loadJurisdictions(),
    loadBodies(),
  );
  const meetings = spec.meetings.map((slug) => getMeetingData(slug));
  const registry = loadPeople();

  const slugs = spec.people === "all" ? registry.map((p) => p.slug) : [];
  for (const meeting of meetings) {
    for (const seg of meeting.segments) {
      if (
        seg.speaker.kind === "identified" &&
        seg.words.length > 0 &&
        !slugs.includes(seg.speaker.person)
      )
        slugs.push(seg.speaker.person);
    }
  }
  const voiceprints =
    spec.voiceprints === "audio"
      ? await (
          await import("./audio-voiceprints")
        ).audioVoiceprints(slugs, meetings)
      : placeholderVoiceprints(slugs);
  const personBySlug = new Map(registry.map((p) => [p.slug, p]));
  const people = slugs.flatMap((slug) => {
    const voiceprint = voiceprints.get(slug);
    if (!voiceprint) return [];
    return [
      {
        slug,
        name: personBySlug.get(slug)?.name ?? null,
        bio: personBySlug.get(slug)?.bio ?? null,
        voice_embedding: Array.from(voiceprint),
      },
    ];
  });
  const personIdBySlug = new Map(people.map((p, i) => [p.slug, i + 1]));
  const personRows = people.map((p, i) => ({ id: i + 1, ...p }));

  const meetingBodies = meetings.flatMap((m, i) =>
    meetingBodyIds(m, bodyIdBySlug).map((body_id) => ({
      meeting_id: i + 1,
      body_id,
    })),
  );

  // A recording's key, for matching meetings to recordings.jsonl.
  const keyOf = (r: { site: string; external_id: string }) =>
    `${r.site} ${r.external_id}`;
  const meetingRecordings = new Set(meetings.map((m) => keyOf(m.recording)));
  const recordings = loadRecordings().filter(
    (r) => spec.recordings === "all" || meetingRecordings.has(keyOf(r)),
  );
  const recordingRows = recordings.map(
    ({ body_slugs: _bodies, published_at, duration_secs, ...r }, i) => ({
      id: i + 1,
      ...r,
      published_at: published_at === null ? null : new Date(published_at),
      // Postgres reads a bare number as seconds.
      duration_secs: duration_secs === null ? null : `${duration_secs}`,
    }),
  );
  const recordingIdByKey = new Map(recordingRows.map((r) => [keyOf(r), r.id]));
  const recordingBodies = recordings.flatMap((r, i) =>
    r.body_slugs.map((slug) => {
      const body_id = bodyIdBySlug.get(slug);
      if (body_id === undefined) {
        throw new Error(
          `Recording ${r.site} ${r.external_id} has unknown body "${slug}"`,
        );
      }
      return { recording_id: i + 1, body_id };
    }),
  );

  const recordingIdOf = (m: (typeof meetings)[number]) => {
    const id = recordingIdByKey.get(keyOf(m.recording));
    if (id === undefined) {
      throw new Error(
        `Golden meeting "${m.slug}" is recording ${keyOf(m.recording)}, which recordings.jsonl doesn't have`,
      );
    }
    return id;
  };

  const meetingRows = meetings.map((m, i) => {
    const lastWord = m.segments.flatMap((s) => s.words).at(-1);
    return {
      id: i + 1,
      slug: m.slug,
      timezone: m.timezone,
      recording_id: recordingIdOf(m),
      title: m.title,
      date: m.date,
      time: m.time,
      duration_secs: lastWord
        ? sql`make_interval(secs => ${lastWord.start + LAST_WORD_DURATION_SEC})`
        : null,
    };
  });

  const segments = meetings.flatMap((m, i) =>
    m.segments
      .filter((seg) => seg.words.length > 0)
      .map((seg) => ({
        meeting_id: i + 1,
        person_id:
          seg.speaker.kind === "identified"
            ? (personIdBySlug.get(seg.speaker.person) ?? null)
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
  meetings.forEach((m, i) => {
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
      SEEDED_TABLES.map((t) => sql`${t}`),
      sql.raw(", "),
    );
    await tx.execute(sql`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    await tx.insert(jurisdictionsTable).values(jurisdictions);
    await tx.insert(bodiesTable).values(bodies);
    if (personRows.length) await tx.insert(peopleTable).values(personRows);
    if (recordingRows.length) {
      await tx.insert(recordingsTable).values(recordingRows);
    }
    if (recordingBodies.length)
      await tx.insert(recordingBodiesTable).values(recordingBodies);
    if (meetingRows.length) await tx.insert(meetingsTable).values(meetingRows);
    if (meetingBodies.length)
      await tx.insert(meetingBodiesTable).values(meetingBodies);
    for (let i = 0; i < segments.length; i += INSERT_CHUNK) {
      await tx
        .insert(segmentsTable)
        .values(segments.slice(i, i + INSERT_CHUNK));
    }
    if (chapterGenerations.length) {
      await tx.insert(chapterGenerationsTable).values(chapterGenerations);
      await tx.insert(chaptersTable).values(chapters);
    }
    await advanceIdSequences(tx, SEEDED_TABLES);
    return {
      jurisdictions: jurisdictions.length,
      bodies: bodies.length,
      people: personRows.length,
      recordings: recordingRows.length,
      recording_bodies: recordingBodies.length,
      meetings: meetingRows.length,
      meeting_bodies: meetingBodies.length,
      segments: segments.length,
      chapter_generations: chapterGenerations.length,
      chapters: chapters.length,
    };
  });
}
