import { sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  chapterGenerationsTable,
  chaptersTable,
  meetingBodiesTable,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/db";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { transcriptFingerprint } from "@open-minutes/core/transcript-fingerprint";
import type { GoldenMeeting, GoldenPerson } from "../test-data";
import { meetingBodyIds } from "./map";
import { advanceIdSequences } from "./sequences";

// Seeds golden meetings on top of the golden rows (goldenData): the meetings,
// their speaker-attributed segments, chapters, and people. Datasets differ only
// in where voiceprints come from, so the caller supplies them: the dev dataset
// uses placeholders, @open-minutes/ingest computes real ones from the audio
// (which needs @open-minutes/audio, a package fixtures can't depend on).

/**
 * Bump when seedGoldenMeetings' behavior changes in a way the fixture files
 * don't capture. Datasets built on it include it in their fingerprints.
 */
export const GOLDEN_MEETINGS_SEED_VERSION = 1;

/**
 * A voiceprint for each of `slugs`, from `meetings`. Every person needs one,
 * so a slug left out of the result isn't seeded, and its segments are seeded
 * with no person.
 */
export type Voiceprints = (
  slugs: readonly string[],
  meetings: readonly GoldenMeeting[],
) => Promise<ReadonlyMap<string, ArrayLike<number>>>;

export interface SeedGoldenMeetingsOptions {
  /** people.jsonl: names and bios for the people seeded. */
  registry: readonly GoldenPerson[];
  /**
   * "registry": everyone in `registry`, plus anyone the meetings identify who
   * isn't listed. "speakers": only the people the meetings identify.
   */
  people: "registry" | "speakers";
  voiceprints: Voiceprints;
}

/** Per-table count of rows inserted by a seed. */
export type SeedSummary = Record<string, number>;

// Every table the seeder owns, truncated together. Not meeting_bodies, which
// has no id sequence for advanceIdSequences, and goes with its meetings.
const SEEDED_TABLES = [
  chaptersTable,
  chapterGenerationsTable,
  segmentsTable,
  meetingsTable,
  peopleTable,
];

const INSERT_CHUNK = 500;

/**
 * Replace the meetings, people, segments and chapters with `meetings`, in one
 * transaction. The meetings' bodies must already be seeded. Ids are assigned
 * in order (meetings in `meetings` order, people in registry order, then
 * speakers in order of appearance), so URLs like `/meetings/1` stay stable
 * across reseeds.
 */
export async function seedGoldenMeetings(
  db: DB,
  meetings: readonly GoldenMeeting[],
  options: SeedGoldenMeetingsOptions,
): Promise<SeedSummary> {
  const slugs =
    options.people === "registry" ? options.registry.map((p) => p.slug) : [];
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
  const voiceprints = await options.voiceprints(slugs, meetings);
  const personBySlug = new Map(options.registry.map((p) => [p.slug, p]));
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

  const meetingRows = meetings.map((m, i) => {
    const lastWord = m.segments.flatMap((s) => s.words).at(-1);
    return {
      id: i + 1,
      slug: m.slug,
      timezone: m.timezone,
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
    const bodyIdBySlug = new Map(
      (
        await tx
          .select({ id: bodiesTable.id, slug: bodiesTable.slug })
          .from(bodiesTable)
      ).map((b) => [b.slug, b.id]),
    );
    const meetingBodies = meetings.flatMap((m, i) =>
      meetingBodyIds(m, bodyIdBySlug).map((body_id) => ({
        meeting_id: i + 1,
        body_id,
      })),
    );

    const tables = sql.join(
      SEEDED_TABLES.map((t) => sql`${t}`),
      sql.raw(", "),
    );
    await tx.execute(sql`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    if (personRows.length) await tx.insert(peopleTable).values(personRows);
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
      people: personRows.length,
      meetings: meetingRows.length,
      meeting_bodies: meetingBodies.length,
      segments: segments.length,
      chapter_generations: chapterGenerations.length,
      chapters: chapters.length,
    };
  });
}
