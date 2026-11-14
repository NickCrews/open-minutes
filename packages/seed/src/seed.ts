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
import { siteAdapter } from "@open-minutes/meeting-audio";
import {
  getMeetingData,
  loadBodies,
  loadJurisdictions,
  loadPeople,
} from "@open-minutes/datasets/datums";
import { bodyRows, meetingBodyIds } from "./map";
import { advanceIdSequences } from "./sequences";
import type { Dataset } from "@open-minutes/datasets";
import { placeholderVoiceprints } from "./voiceprints";

/**
 * Bump when seedDataset's behavior changes in a way the datasets and datums
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
 * Replace every table the dataset covers with the rows `dataset` declares, in
 * one
 * transaction. Ids are assigned in order (meetings in `dataset.meetings` order,
 * people in people.jsonl order, then speakers in order of appearance), so URLs
 * like `/meetings/1` stay stable across reseeds.
 *
 * Every person needs a voiceprint, so a speaker with too little speech to
 * embed isn't seeded, and their segments are seeded with no person.
 */
export async function seedDataset(
  db: DB,
  dataset: Dataset,
): Promise<SeedSummary> {
  const { jurisdictions, bodies, bodyIdBySlug } = bodyRows(
    loadJurisdictions(),
    loadBodies(),
  );
  const meetings = dataset.meetings.map((slug) => getMeetingData(slug));
  const registry = loadPeople();

  const slugs = dataset.people === "all" ? registry.map((p) => p.slug) : [];
  for (const meeting of meetings) {
    for (const seg of meeting.segments) {
      if (
        seg.person !== null &&
        seg.words.length > 0 &&
        !slugs.includes(seg.person)
      )
        slugs.push(seg.person);
    }
  }
  const voiceprints =
    dataset.voiceprints === "audio"
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

  // Each fixture's recording has the same id as its meeting. Its audio is in
  // the blob store already.
  const storedAt = new Date();
  const durations = meetings.map(
    (m) => sql`make_interval(secs => ${m.duration_secs})`,
  );
  const recordingRows = meetings.map((m, i) => ({
    id: i + 1,
    site: m.site,
    external_id: m.external_id,
    permalink: siteAdapter(m.site).permalink(m.external_id),
    title: m.title,
    duration_secs: durations[i] ?? "0",
    is_meeting: true,
    audio_stored_at: storedAt,
  }));
  const recordingBodies = meetingBodies.map(({ meeting_id, body_id }) => ({
    recording_id: meeting_id,
    body_id,
  }));

  const meetingRows = meetings.map((m, i) => ({
    id: i + 1,
    slug: m.slug,
    recording_id: i + 1,
    timezone: m.timezone,
    title: m.title,
    date: m.date,
    time: m.time,
    duration_secs: durations[i],
  }));

  const segments = meetings.flatMap((m, i) =>
    m.segments
      .filter((seg) => seg.words.length > 0)
      .map((seg) => ({
        meeting_id: i + 1,
        person_id:
          seg.person === null ? null : (personIdBySlug.get(seg.person) ?? null),
        speaker_number: seg.speakerNumber,
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
        bullets: [...c.bullets],
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
      await tx.insert(recordingBodiesTable).values(recordingBodies);
    }
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
