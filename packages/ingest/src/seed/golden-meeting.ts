import { eq } from "drizzle-orm";
import {
  type DB,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/db";
import {
  LAST_WORD_DURATION_SEC,
  type DiarizationTurn,
} from "@open-minutes/core/transcription";
import { computeSpeakerEmbeddings } from "@open-minutes/audio/embed";
import type {
  GoldenMeeting,
  GoldenPerson,
} from "@open-minutes/fixtures/test-data";
import { getMeetingAudio } from "../test-utils/audio-cache";

// Seed a hand-verified golden meeting into the database as established ground
// truth: the meeting row, its speaker-attributed segments, and a voiceprint per
// identified person. This is the "known past" an end-to-end test recognizes a
// later, unseen meeting against — the same person (by slug) learned here must be
// re-identified there purely from their voice.
//
// Not collected by vitest (no .test suffix). Reached only through the
// goldenMeetingsData dataset (golden-meetings-data.ts), never called directly.

/**
 * Seed one golden meeting. Returns the seeded `slug → person_id` map so callers
 * can score a later meeting's identifications against it.
 *
 * `peopleBySlug` supplies display names (from people.jsonl) for identified
 * speakers; a slug with no entry is still seeded, just with a null name.
 */
export async function seedGoldenMeeting(
  db: DB,
  bodyId: number,
  meeting: GoldenMeeting,
  peopleBySlug: ReadonlyMap<string, GoldenPerson>,
): Promise<Map<string, number>> {
  // 1. Voiceprint every identified person from the audio spans they speak. The
  //    audio (a ~600 MB wav) is only loaded when there is someone to embed, so a
  //    transcript-only golden (no identified people) costs no audio read.
  const hasIdentified = meeting.segments.some(
    (s) => s.speaker.kind === "identified" && s.words.length > 0,
  );
  const slugToPersonId = hasIdentified
    ? await seedIdentifiedPeople(
        db,
        await getMeetingAudio(meeting).then((a) => a.path),
        meeting.segments,
        peopleBySlug,
      )
    : new Map<string, number>();

  // 2. Insert the meeting row.
  const [meetingRow] = await db
    .insert(meetingsTable)
    .values({
      slug: meeting.slug,
      body_id: bodyId,
      site_kind: "youtube",
      site_id: meeting.youtube_id,
      title: meeting.title,
      date: meeting.date,
      time: meeting.time,
    })
    .returning({ id: meetingsTable.id });
  const meetingId = meetingRow!.id;

  // 3. Insert segments, resolving identified speakers to their seeded person_id
  //    and preserving the anonymous cluster number for segmented ones.
  for (const seg of meeting.segments) {
    if (seg.words.length === 0) continue;
    await db.insert(segmentsTable).values({
      meeting_id: meetingId,
      person_id:
        seg.speaker.kind === "identified"
          ? (slugToPersonId.get(seg.speaker.person) ?? null)
          : null,
      speaker_number:
        seg.speaker.kind === "segmented" ? seg.speaker.cluster : null,
      words: seg.words,
    });
  }

  return slugToPersonId;
}

/**
 * Build one voiceprint per identified person and upsert them as people (keyed by
 * slug), so recurring people accumulate a single stable row across seed
 * meetings. A person whose speech is too short to embed reliably is skipped.
 */
async function seedIdentifiedPeople(
  db: DB,
  audioPath: string,
  segments: GoldenMeeting["segments"],
  peopleBySlug: ReadonlyMap<string, GoldenPerson>,
): Promise<Map<string, number>> {
  // Give each identified person a synthetic speaker index, then reuse the
  // pipeline's per-speaker centroid builder (it expects DiarizationTurns keyed by
  // number). Each identified segment becomes one turn.
  const slugToIndex = new Map<string, number>();
  const turns: DiarizationTurn[] = [];
  for (const seg of segments) {
    if (seg.speaker.kind !== "identified" || seg.words.length === 0) continue;
    const slug = seg.speaker.person;
    let index = slugToIndex.get(slug);
    if (index === undefined) {
      index = slugToIndex.size;
      slugToIndex.set(slug, index);
    }
    turns.push({
      start: seg.words[0]!.start,
      end: seg.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
      speakerNum: index,
    });
  }

  const centroids = computeSpeakerEmbeddings(audioPath, turns);
  const slugToPersonId = new Map<string, number>();
  for (const [slug, index] of slugToIndex) {
    const centroid = centroids.get(index);
    if (!centroid) continue; // too little speech to embed reliably
    const personId = await upsertPersonBySlug(
      db,
      slug,
      peopleBySlug.get(slug)?.name ?? null,
      centroid,
    );
    slugToPersonId.set(slug, personId);
  }
  return slugToPersonId;
}

/**
 * Insert a person keyed by slug, or return the existing row's id if this person
 * was already seeded from an earlier meeting (first voiceprint wins — good
 * enough for a first-pass fixture; a later pass could average across meetings).
 */
async function upsertPersonBySlug(
  db: DB,
  slug: string,
  name: string | null,
  centroid: Float32Array,
): Promise<number> {
  const [inserted] = await db
    .insert(peopleTable)
    .values({ slug, name, voice_embedding: Array.from(centroid) })
    .onConflictDoNothing({ target: peopleTable.slug })
    .returning({ id: peopleTable.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: peopleTable.id })
    .from(peopleTable)
    .where(eq(peopleTable.slug, slug))
    .limit(1);
  return existing!.id;
}
