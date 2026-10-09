import { count, eq } from "drizzle-orm";
import { meetingsTable, peopleTable, segmentsTable } from "@open-minutes/db";
import type { TranscriptSegment } from "@open-minutes/core/transcription";
import type { Db } from "./db";
import type { RecognitionArtifact } from "./recognize";
import type { EmbeddingsArtifact } from "./steps";
import { PipelineError, readArtifact } from "./work-dir";

/**
 * Write a meeting's transcript to the database in one transaction: a new
 * anonymous person for each speaker recognition left unmatched, the aligned
 * segments (segments.json) attributed to their people, and
 * `meetings.transcribed_at`. Refuses a meeting that already has a transcript.
 */
export async function saveTranscript(
  db: Db,
  meetingId: number,
  dir: string,
): Promise<{ segments: number; recognized: number; newPeople: number }> {
  const segments = await readArtifact<TranscriptSegment[]>(
    dir,
    "segments",
    "align_speakers",
  );
  const embeddings = await readArtifact<EmbeddingsArtifact>(
    dir,
    "embeddings",
    "embed_speakers",
  );
  const recognition = await readArtifact<RecognitionArtifact>(
    dir,
    "recognition",
    "recognize_speakers",
  );

  return db.transaction(async (tx) => {
    const [meeting] = await tx
      .select({ transcribedAt: meetingsTable.transcribed_at })
      .from(meetingsTable)
      .where(eq(meetingsTable.id, meetingId))
      .for("update");
    if (!meeting) throw new PipelineError(`No meeting ${meetingId}`);
    const [existing] = await tx
      .select({ n: count() })
      .from(segmentsTable)
      .where(eq(segmentsTable.meeting_id, meetingId));
    if (meeting.transcribedAt !== null || existing!.n > 0)
      throw new PipelineError(`Meeting ${meetingId} already has a transcript`);

    const personBySpeaker = new Map<number, number>();
    let newPeople = 0;
    for (const { speaker, personId } of recognition) {
      if (personId !== null) {
        personBySpeaker.set(speaker, personId);
        continue;
      }
      const embedding = embeddings.find((e) => e.speaker === speaker);
      if (!embedding)
        throw new PipelineError(
          `recognition.json has speaker ${speaker}, embeddings.json doesn't: run recognize_speakers again`,
        );
      const [created] = await tx
        .insert(peopleTable)
        // Name is left null: diarization tells us this is a distinct voice,
        // not who it belongs to.
        .values({ voice_embedding: embedding.centroid })
        .returning({ id: peopleTable.id });
      personBySpeaker.set(speaker, created!.id);
      newPeople++;
    }

    for (const seg of segments) {
      // text/start_secs/end_secs/duration_secs are generated from `words`.
      await tx.insert(segmentsTable).values({
        meeting_id: meetingId,
        person_id:
          seg.speakerNum === null
            ? null
            : (personBySpeaker.get(seg.speakerNum) ?? null),
        speaker_number: seg.speakerNum,
        words: seg.words,
      });
    }
    await tx
      .update(meetingsTable)
      .set({ transcribed_at: new Date() })
      .where(eq(meetingsTable.id, meetingId));
    return {
      segments: segments.length,
      recognized: recognition.length - newPeople,
      newPeople,
    };
  });
}
