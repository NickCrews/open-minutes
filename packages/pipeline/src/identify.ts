import { cosineDistance, sql } from "drizzle-orm";
import { type DB, peopleTable, segmentsTable } from "@open-minutes/core/db";
import { TranscriptWord } from "@open-minutes/core/transcription";

// Accepts either a database or a transaction handle, so callers can make
// segment insertion part of a larger all-or-nothing transaction.
type Queryable = Pick<DB, "select" | "insert">;

// Confidence tiers from OpenWhispr's matching system:
//   ≥ 0.70 cosine similarity → auto-confirm
//   0.55–0.70               → suggest (we auto-confirm here too)
//   < 0.55                  → new person
const MATCH_THRESHOLD = 0.55;
const MAX_DISTANCE = 1 - MATCH_THRESHOLD;

export async function identifyAndInsertSegments(
  db: Queryable,
  meetingId: number,
  alignedSegments: Array<{
    text: string;
    start: number;
    end: number;
    /** Local diarization label, or null for an unlabeled (undiarized) segment. */
    speaker: number | null;
    words: Array<TranscriptWord>;
  }>,
  speakerEmbeddings: Map<number, Float32Array>,
): Promise<void> {
  // Resolve each local speaker index to a DB person
  const speakerToPersonId = new Map<number, number>();
  for (const [speakerId, embedding] of speakerEmbeddings) {
    speakerToPersonId.set(speakerId, await findOrCreatePerson(db, embedding));
  }

  for (const seg of alignedSegments) {
    await db.insert(segmentsTable).values({
      meeting_id: meetingId,
      person_id:
        seg.speaker === null
          ? null
          : (speakerToPersonId.get(seg.speaker) ?? null),
      speaker_number: seg.speaker,
      start_secs: sql`make_interval(secs => ${seg.start})`,
      end_secs: sql`make_interval(secs => ${seg.end})`,
      words: seg.words,
    });
  }
}

async function findOrCreatePerson(
  db: Queryable,
  embedding: Float32Array,
): Promise<number> {
  const vec = Array.from(embedding);
  const distance = cosineDistance(peopleTable.voice_embedding, vec);

  const [match] = await db
    .select({ id: peopleTable.id })
    .from(peopleTable)
    .where(sql`${distance} < ${MAX_DISTANCE}`)
    .orderBy(distance)
    .limit(1);

  if (match) return match.id;

  const [created] = await db
    .insert(peopleTable)
    // Name is left null: diarization tells us this is a distinct voice, not who
    // it belongs to. The UI renders null-named people as anonymous placeholders.
    .values({ voice_embedding: vec })
    .returning({ id: peopleTable.id });
  return created!.id;
}
