import { cosineDistance, sql } from "drizzle-orm";
import { type DB, peopleTable, segmentsTable } from "@gbos/core/db";

// Confidence tiers from OpenWhispr's matching system:
//   ≥ 0.70 cosine similarity → auto-confirm
//   0.55–0.70               → suggest (we auto-confirm here too)
//   < 0.55                  → new person
const MATCH_THRESHOLD = 0.55;
const MAX_DISTANCE = 1 - MATCH_THRESHOLD;

export async function identifyAndInsertSegments(
  db: DB,
  meetingId: number,
  alignedSegments: Array<{
    text: string;
    start: number;
    end: number;
    speaker: number;
    words: Array<{ text: string; start: number; end: number }>;
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
      person_id: speakerToPersonId.get(seg.speaker) ?? null,
      text: seg.text,
      start_secs: sql`make_interval(secs => ${seg.start})`,
      end_secs: sql`make_interval(secs => ${seg.end})`,
      words: seg.words,
    });
  }
}

async function findOrCreatePerson(
  db: DB,
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
    .values({ name: "Unknown Speaker", voice_embedding: vec })
    .returning({ id: peopleTable.id });
  return created!.id;
}
