// Publish a golden meeting into a database that already has other data, such
// as production: the reverse of export, for a golden whose files are ahead of
// the database. Unlike seeding, it changes only that meeting and the people
// it names, and keeps every other row.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  bodiesTable,
  chapterGenerationsTable,
  chaptersTable,
  type DB,
  meetingBodiesTable,
  meetingsTable,
  peopleTable,
  recordingBodiesTable,
  recordingsTable,
  segmentsTable,
} from "@open-minutes/db";
import {
  type GoldenMeeting,
  type GoldenPerson,
  getMeetingData,
  loadPeople as loadGoldenPeople,
} from "@open-minutes/datasets/datums";
import { siteAdapter } from "@open-minutes/meeting-audio";
import { transcriptFingerprint } from "@open-minutes/seed/transcript-fingerprint";
import type { Conn } from "./meeting";

/** Voiceprints for people the database doesn't have yet, by slug. */
export type VoiceprintSource = (
  slugs: readonly string[],
  meeting: GoldenMeeting,
) => Promise<ReadonlyMap<string, ArrayLike<number>>>;

/** Real voiceprints, from the meeting's audio. */
export const audioVoiceprints: VoiceprintSource = async (slugs, meeting) => {
  const { audioVoiceprints } =
    await import("@open-minutes/seed/audio-voiceprints");
  return audioVoiceprints(slugs, [meeting]);
};

export interface PublishOptions {
  /** Where voiceprints come from for people the database doesn't have. */
  voiceprints?: VoiceprintSource;
  /** Report what would change, and save nothing. */
  dryRun?: boolean;
}

/** How a golden person maps to a row. */
type PersonPlan =
  | { kind: "slug"; id: number }
  | { kind: "name"; id: number }
  | { kind: "new" };

class Rollback extends Error {}

/**
 * Make the database's copy of golden meeting `slug` match its files: the
 * meeting row (found by slug, else by its recording), its bodies, segments and
 * chapters, and the name and bio of everyone it names. A person is found by
 * slug, else as the one person with the same name and no slug, who is given
 * the slug; anyone else is added, with a voiceprint from `voiceprints`.
 * Returns a line per change.
 */
export async function publishGolden(
  db: DB,
  slug: string,
  { voiceprints = audioVoiceprints, dryRun = false }: PublishOptions = {},
): Promise<string[]> {
  const golden = getMeetingData(slug);
  const registry = new Map(loadGoldenPeople().map((p) => [p.slug, p]));
  const slugs = [
    ...new Set(golden.segments.flatMap((s) => (s.person ? [s.person] : []))),
  ];
  const missing = slugs.filter((s) => !registry.has(s));
  if (missing.length)
    throw new Error(`Not in people.jsonl: ${missing.join(", ")}`);

  const plans = await planPeople(db, slugs, registry);
  const fresh = slugs.filter((s) => plans.get(s)!.kind === "new");
  const prints = fresh.length ? await voiceprints(fresh, golden) : new Map();
  const unprinted = fresh.filter((s) => !prints.has(s));
  if (unprinted.length)
    throw new Error(
      `No voiceprint for ${unprinted.join(", ")}: too little speech to embed`,
    );

  const notes: string[] = [];
  try {
    await db.transaction(async (tx) => {
      const personIds = new Map<string, number>();
      for (const s of slugs) {
        const plan = plans.get(s)!;
        const p = registry.get(s)!;
        const fields = { slug: s, name: p.name, bio: p.bio ?? null };
        if (plan.kind === "new") {
          const [row] = await tx
            .insert(peopleTable)
            .values({ ...fields, voice_embedding: Array.from(prints.get(s)!) })
            .returning({ id: peopleTable.id });
          personIds.set(s, row!.id);
          notes.push(`person ${row!.id}: added ${s}`);
        } else {
          await tx
            .update(peopleTable)
            .set(fields)
            .where(eq(peopleTable.id, plan.id));
          personIds.set(s, plan.id);
          notes.push(
            plan.kind === "name"
              ? `person ${plan.id}: named ${JSON.stringify(p.name)}, given slug ${s}`
              : `person ${plan.id}: ${s}, name and bio set`,
          );
        }
      }

      const bodies = await bodyIds(tx, golden.body_slugs);
      const meetingId = await upsertMeeting(tx, golden, bodies, notes);
      await tx
        .delete(meetingBodiesTable)
        .where(eq(meetingBodiesTable.meeting_id, meetingId));
      await tx
        .insert(meetingBodiesTable)
        .values(bodies.map((body_id) => ({ meeting_id: meetingId, body_id })));

      const deleted = await tx
        .delete(segmentsTable)
        .where(eq(segmentsTable.meeting_id, meetingId))
        .returning({ id: segmentsTable.id });
      const rows = golden.segments
        .filter((s) => s.words.length)
        .map((s) => ({
          meeting_id: meetingId,
          person_id: s.person === null ? null : personIds.get(s.person)!,
          speaker_number: s.speakerNumber,
          words: s.words,
        }));
      for (let i = 0; i < rows.length; i += 500)
        await tx.insert(segmentsTable).values(rows.slice(i, i + 500));
      notes.push(`segments: replaced ${deleted.length} with ${rows.length}`);

      await tx
        .delete(chaptersTable)
        .where(eq(chaptersTable.meeting_id, meetingId));
      if (golden.chapters) {
        const [generation] = await tx
          .insert(chapterGenerationsTable)
          .values({
            meeting_id: meetingId,
            ...golden.chapters.generation,
            transcript_fingerprint: transcriptFingerprint(golden.segments),
          })
          .returning({ id: chapterGenerationsTable.id });
        await tx.insert(chaptersTable).values(
          golden.chapters.chapters.map((c) => ({
            meeting_id: meetingId,
            generation_id: generation!.id,
            start_secs: `${c.start}`,
            end_secs: `${c.end}`,
            title: c.title,
            summary: c.summary,
            bullets: [...c.bullets],
          })),
        );
        notes.push(
          `chapters: ${golden.chapters.chapters.length}, as generation ${generation!.id}`,
        );
      } else notes.push("chapters: none");

      if (dryRun) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return notes;
}

/** How each slug maps to a row: by slug, by name, or a new person. */
async function planPeople(
  db: Conn,
  slugs: readonly string[],
  registry: ReadonlyMap<string, GoldenPerson>,
): Promise<Map<string, PersonPlan>> {
  const plans = new Map<string, PersonPlan>();
  const adopted = new Set<number>();
  for (const s of slugs) {
    const [bySlug] = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(eq(peopleTable.slug, s));
    if (bySlug) {
      plans.set(s, { kind: "slug", id: bySlug.id });
      continue;
    }
    const byName = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(
        and(
          isNull(peopleTable.slug),
          sql`lower(${peopleTable.name}) = lower(${registry.get(s)!.name})`,
        ),
      );
    const only = byName.length === 1 ? byName[0]!.id : undefined;
    if (only !== undefined && !adopted.has(only)) {
      adopted.add(only);
      plans.set(s, { kind: "name", id: only });
    } else plans.set(s, { kind: "new" });
  }
  return plans;
}

/**
 * The meeting's row, found by slug or by its recording and updated, or added,
 * with its recording.
 */
async function upsertMeeting(
  db: Conn,
  golden: GoldenMeeting,
  bodyIds: readonly number[],
  notes: string[],
): Promise<number> {
  const duration_secs = sql`make_interval(secs => ${golden.duration_secs})`;
  const [recording] = await db
    .insert(recordingsTable)
    .values({
      site: golden.site,
      external_id: golden.external_id,
      permalink: siteAdapter(golden.site).permalink(golden.external_id),
      title: golden.title,
      duration_secs,
      is_meeting: true,
    })
    .onConflictDoUpdate({
      target: [recordingsTable.site, recordingsTable.external_id],
      set: { is_meeting: true },
    })
    .returning({ id: recordingsTable.id });
  if (bodyIds.length)
    await db
      .insert(recordingBodiesTable)
      .values(
        bodyIds.map((body_id) => ({ recording_id: recording!.id, body_id })),
      )
      .onConflictDoNothing();
  const fields = {
    slug: golden.slug,
    recording_id: recording!.id,
    title: golden.title,
    timezone: golden.timezone,
    date: golden.date,
    time: golden.time,
    duration_secs,
  };
  const found = await db
    .select({ id: meetingsTable.id })
    .from(meetingsTable)
    .where(
      or(
        eq(meetingsTable.slug, golden.slug),
        eq(meetingsTable.recording_id, recording!.id),
      ),
    );
  if (found.length > 1)
    throw new Error(
      `Meetings ${found.map((m) => m.id).join(" and ")} are both ${golden.slug}: one by slug, one by recording`,
    );
  const existing = found[0];
  if (existing) {
    await db
      .update(meetingsTable)
      .set(fields)
      .where(eq(meetingsTable.id, existing.id));
    notes.push(`meeting ${existing.id}: updated`);
    return existing.id;
  }
  const [row] = await db
    .insert(meetingsTable)
    .values(fields)
    .returning({ id: meetingsTable.id });
  notes.push(`meeting ${row!.id}: added, with recording ${recording!.id}`);
  return row!.id;
}

async function bodyIds(db: Conn, slugs: readonly string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const s of slugs) {
    const [row] = await db
      .select({ id: bodiesTable.id })
      .from(bodiesTable)
      .where(eq(bodiesTable.slug, s));
    if (!row) throw new Error(`No body ${JSON.stringify(s)} in the database`);
    ids.push(row.id);
  }
  return ids;
}
