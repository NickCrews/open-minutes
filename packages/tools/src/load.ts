import { asc, eq } from "drizzle-orm";
import { chaptersTable, peopleTable, segmentsTable } from "@open-minutes/db";
import type { TranscriptWord } from "@open-minutes/core/transcription";
import type { Db } from "./tool";

/** Seconds from a Postgres interval like "01:02:03.45", or null. */
export function intervalSecs(interval: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(interval);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** Seconds to two decimals, so JSON stays readable. */
export const round = (secs: number) => Math.round(secs * 100) / 100;

export interface LoadedSegment {
  id: number;
  meeting_id: number;
  person_id: number | null;
  speaker_number: number | null;
  slug: string | null;
  name: string | null;
  words: TranscriptWord[];
}

/** A meeting's segments in time order, with their people. */
export async function loadSegments(
  db: Db,
  meetingId: number,
): Promise<LoadedSegment[]> {
  return db
    .select({
      id: segmentsTable.id,
      meeting_id: segmentsTable.meeting_id,
      person_id: segmentsTable.person_id,
      speaker_number: segmentsTable.speaker_number,
      slug: peopleTable.slug,
      name: peopleTable.name,
      words: segmentsTable.words,
    })
    .from(segmentsTable)
    .leftJoin(peopleTable, eq(peopleTable.id, segmentsTable.person_id))
    .where(eq(segmentsTable.meeting_id, meetingId))
    .orderBy(asc(segmentsTable.start_secs), asc(segmentsTable.id));
}

/**
 * Who a segment is attributed to: a person (named or anonymous), a bare
 * speaker number from diarization, or nobody (null, "unattributed").
 */
export type Speaker =
  | { personId: number; slug: string | null; name: string | null }
  | { speakerNumber: number }
  | null;

export function speakerOf(seg: LoadedSegment): Speaker {
  if (seg.person_id != null)
    return { personId: seg.person_id, slug: seg.slug, name: seg.name };
  if (seg.speaker_number != null) return { speakerNumber: seg.speaker_number };
  return null;
}

/** A meeting's chapters in order, with times in seconds. */
export async function loadChapters(db: Db, meetingId: number) {
  const rows = await db
    .select()
    .from(chaptersTable)
    .where(eq(chaptersTable.meeting_id, meetingId))
    .orderBy(asc(chaptersTable.start_secs));
  return rows.map(({ start_secs, end_secs, ...c }) => ({
    ...c,
    start: intervalSecs(start_secs) ?? 0,
    end: intervalSecs(end_secs) ?? 0,
  }));
}
