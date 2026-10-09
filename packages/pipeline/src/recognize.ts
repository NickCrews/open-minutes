import { cosineDistance, sql } from "drizzle-orm";
import { type DB, peopleTable } from "@open-minutes/db";
import type { EmbeddingsArtifact } from "./steps";
import { readArtifact, writeArtifact } from "./work-dir";

// Confidence tiers from OpenWhispr's matching system:
//   ≥ 0.70 cosine similarity → auto-confirm
//   0.55–0.70               → suggest (we auto-confirm here too)
//   < 0.55                  → new person
const MATCH_THRESHOLD = 0.55;
const MAX_DISTANCE = 1 - MATCH_THRESHOLD;

/**
 * On-disk shape of recognition.json: for each speaker with a voiceprint, the
 * person in the database whose voiceprint is closest, or null when nobody's
 * is close enough.
 */
export type RecognitionArtifact = Array<{
  speaker: number;
  personId: number | null;
  /** Cosine similarity to that person's voiceprint. */
  similarity: number | null;
}>;

/**
 * Match each speaker's voiceprint (embeddings.json) against the voiceprints
 * of the people in the database: recognition.json. Reads the database but
 * doesn't change it; saveTranscript creates a person for each speaker left
 * unmatched.
 */
export async function recognizeSpeakers(
  db: DB,
  dir: string,
): Promise<RecognitionArtifact> {
  const embeddings = await readArtifact<EmbeddingsArtifact>(
    dir,
    "embeddings",
    "embedSpeakers",
  );
  const recognition: RecognitionArtifact = [];
  for (const { speaker, centroid } of embeddings) {
    const distance = cosineDistance(peopleTable.voice_embedding, centroid);
    const [match] = await db
      .select({ id: peopleTable.id, distance: sql<number>`${distance}` })
      .from(peopleTable)
      .where(sql`${distance} < ${MAX_DISTANCE}`)
      .orderBy(distance)
      .limit(1);
    recognition.push({
      speaker,
      personId: match?.id ?? null,
      similarity: match ? Math.round((1 - match.distance) * 1000) / 1000 : null,
    });
  }
  await writeArtifact(dir, "recognition", recognition);
  return recognition;
}
