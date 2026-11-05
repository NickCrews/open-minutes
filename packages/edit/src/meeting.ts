// A meeting as it is in a database, loaded whole for editing, and the writes
// that save an edited transcript back.

import { asc, eq, inArray, sql } from "drizzle-orm";
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
import type { Chapter } from "@open-minutes/core/chapters";
import type { Segment, Word } from "@open-minutes/core/transcript";

/** A database, or a transaction on one. */
export type Conn = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface DbPerson {
  id: number;
  slug: string | null;
  name: string | null;
  bio: string | null;
}

/** A segment, naming its person by `people.id`. */
export type DbSegment = Segment<number> & { id: number };

export interface DbChapterGeneration {
  id: number;
  model: string;
  prompt_version: string;
  reviewed_by_human: boolean;
}

export interface DbMeeting {
  id: number;
  slug: string | null;
  site_kind: string;
  site_id: string;
  title: string;
  description: string;
  timezone: string;
  date: string | null;
  time: string | null;
  durationSecs: number | null;
  bodySlugs: string[];
  /** In order of onset. */
  segments: DbSegment[];
  /** The generation of `chapters`; null when the meeting has none. */
  generation: DbChapterGeneration | null;
  chapters: (Chapter & { id: number })[];
  /** Everyone the segments name, by id. */
  people: Map<number, DbPerson>;
}

const secs = (column: unknown) =>
  sql<number>`extract(epoch from ${column})::float8`;

/**
 * The id of the meeting `ref` names: an id if it is all digits, else a slug.
 * Throws if there's no such meeting.
 */
export async function findMeetingId(db: Conn, ref: string): Promise<number> {
  const where = /^\d+$/.test(ref)
    ? eq(meetingsTable.id, Number(ref))
    : eq(meetingsTable.slug, ref);
  const [row] = await db
    .select({ id: meetingsTable.id })
    .from(meetingsTable)
    .where(where);
  if (!row) throw new Error(`No meeting ${JSON.stringify(ref)}`);
  return row.id;
}

/**
 * Load a meeting whole. With `lock`, inside a transaction, also lock its row,
 * so two edits of one meeting can't interleave.
 */
export async function loadMeeting(
  db: Conn,
  id: number,
  { lock = false } = {},
): Promise<DbMeeting> {
  if (lock)
    await db.execute(
      sql`SELECT 1 FROM ${meetingsTable} WHERE ${meetingsTable.id} = ${id} FOR UPDATE`,
    );
  const [meeting] = await db
    .select({
      id: meetingsTable.id,
      slug: meetingsTable.slug,
      site_kind: meetingsTable.site_kind,
      site_id: meetingsTable.site_id,
      title: meetingsTable.title,
      description: meetingsTable.description,
      timezone: meetingsTable.timezone,
      date: meetingsTable.date,
      time: meetingsTable.time,
      durationSecs: secs(meetingsTable.duration_secs),
    })
    .from(meetingsTable)
    .where(eq(meetingsTable.id, id));
  if (!meeting) throw new Error(`No meeting with id ${id}`);

  const bodies = await db
    .select({ slug: bodiesTable.slug })
    .from(meetingBodiesTable)
    .innerJoin(bodiesTable, eq(bodiesTable.id, meetingBodiesTable.body_id))
    .where(eq(meetingBodiesTable.meeting_id, id))
    .orderBy(asc(bodiesTable.id));

  const segmentRows = await db
    .select({
      id: segmentsTable.id,
      person: segmentsTable.person_id,
      speakerNumber: segmentsTable.speaker_number,
      words: segmentsTable.words,
    })
    .from(segmentsTable)
    .where(eq(segmentsTable.meeting_id, id))
    .orderBy(asc(segmentsTable.start_secs), asc(segmentsTable.id));

  const chapterRows = await db
    .select({
      id: chaptersTable.id,
      generation_id: chaptersTable.generation_id,
      start: secs(chaptersTable.start_secs),
      end: secs(chaptersTable.end_secs),
      title: chaptersTable.title,
      summary: chaptersTable.summary,
      bullets: chaptersTable.bullets,
    })
    .from(chaptersTable)
    .where(eq(chaptersTable.meeting_id, id))
    .orderBy(asc(chaptersTable.start_secs));
  const generationId = chapterRows[0]?.generation_id;
  const [generation] =
    generationId === undefined
      ? []
      : await db
          .select({
            id: chapterGenerationsTable.id,
            model: chapterGenerationsTable.model,
            prompt_version: chapterGenerationsTable.prompt_version,
            reviewed_by_human: chapterGenerationsTable.reviewed_by_human,
          })
          .from(chapterGenerationsTable)
          .where(eq(chapterGenerationsTable.id, generationId));

  const people = await loadPeople(
    db,
    segmentRows.flatMap((s) => (s.person === null ? [] : [s.person])),
  );

  return {
    ...meeting,
    bodySlugs: bodies.map((b) => b.slug),
    segments: segmentRows,
    generation: generation ?? null,
    chapters: chapterRows.map((c) => ({
      id: c.id,
      start: c.start,
      end: c.end,
      title: c.title,
      summary: c.summary,
      bullets: c.bullets,
    })),
    people,
  };
}

/** The people with these ids, by id. */
export async function loadPeople(
  db: Conn,
  ids: readonly number[],
): Promise<Map<number, DbPerson>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db
    .select({
      id: peopleTable.id,
      slug: peopleTable.slug,
      name: peopleTable.name,
      bio: peopleTable.bio,
    })
    .from(peopleTable)
    .where(inArray(peopleTable.id, unique));
  return new Map(rows.map((p) => [p.id, p]));
}

/** What saving a transcript changed, in rows. */
export interface Saved {
  updated: number;
  inserted: number;
  deleted: number;
}

/**
 * Make a meeting's segment rows hold `after`. A segment starting on the same
 * word as an existing row keeps that row (and its id), updated if it changed;
 * the others are inserted, and rows left over are deleted.
 */
export async function saveSegments(
  db: Conn,
  meetingId: number,
  before: readonly DbSegment[],
  after: readonly Segment<number>[],
): Promise<Saved> {
  const byOnset = new Map<number, DbSegment[]>();
  for (const seg of before) {
    const key = onsetKey(seg);
    byOnset.set(key, [...(byOnset.get(key) ?? []), seg]);
  }
  const saved: Saved = { updated: 0, inserted: 0, deleted: 0 };
  const inserts: (typeof segmentsTable.$inferInsert)[] = [];
  for (const seg of after) {
    const row = {
      person_id: seg.person,
      speaker_number: seg.speakerNumber,
      words: plainWords(seg.words),
    };
    const old = byOnset.get(onsetKey(seg))?.shift();
    if (!old) {
      inserts.push({ meeting_id: meetingId, ...row });
      continue;
    }
    if (
      old.person !== seg.person ||
      old.speakerNumber !== seg.speakerNumber ||
      JSON.stringify(plainWords(old.words)) !== JSON.stringify(row.words)
    ) {
      await db
        .update(segmentsTable)
        .set(row)
        .where(eq(segmentsTable.id, old.id));
      saved.updated++;
    }
  }
  const leftover = [...byOnset.values()].flat().map((s) => s.id);
  if (leftover.length) {
    await db.delete(segmentsTable).where(inArray(segmentsTable.id, leftover));
    saved.deleted = leftover.length;
  }
  if (inserts.length) {
    await db.insert(segmentsTable).values(inserts);
    saved.inserted = inserts.length;
  }
  return saved;
}

function onsetKey(seg: Segment<number>): number {
  return Math.round((seg.words[0]?.start ?? -1) * 100);
}

function plainWords(words: readonly Word[]): Word[] {
  return words.map((w) => ({ text: w.text, start: w.start }));
}
