import { eq } from "drizzle-orm";
import { meetingBodiesTable, meetingsTable } from "@open-minutes/db";
import {
  checkMeeting as checkMeetingData,
  type MeetingIssue,
} from "@open-minutes/core/meeting-check";
import { type Db, ToolError } from "./tool";
import { intervalSecs, loadChapters, loadSegments } from "./load";

/**
 * Something wrong, or probably wrong, with a meeting's data: a result from
 * @open-minutes/core/meeting-check with its severity, and with the segment
 * and chapter it names given by row id.
 */
export type Issue = Located<MeetingIssue>;

type Located<I> = I extends unknown
  ? Omit<I, "segment" | "chapter"> &
      (I extends { segment: number } ? { segmentId: number } : unknown) &
      (I extends { chapter: number } ? { chapterId: number } : unknown)
  : never;

/**
 * Check a meeting's bodies, transcript and chapters against the rules in
 * @open-minutes/core/meeting-check, the same ones the golden fixtures follow.
 */
export async function checkMeeting(
  db: Db,
  meetingId: number,
): Promise<Issue[]> {
  const [meeting] = await db
    .select({ duration: meetingsTable.duration_secs })
    .from(meetingsTable)
    .where(eq(meetingsTable.id, meetingId));
  if (!meeting) throw new ToolError(`No meeting ${meetingId}`);
  const segments = await loadSegments(db, meetingId);
  const chapters = await loadChapters(db, meetingId);
  const bodies = await db
    .select({ id: meetingBodiesTable.body_id })
    .from(meetingBodiesTable)
    .where(eq(meetingBodiesTable.meeting_id, meetingId));

  const issues = await checkMeetingData({
    bodyCount: bodies.length,
    durationSecs: meeting.duration ? intervalSecs(meeting.duration) : null,
    segments: segments.map((s) => ({
      speaker:
        s.person_id != null
          ? `person:${s.person_id}`
          : s.speaker_number != null
            ? `speaker:${s.speaker_number}`
            : null,
      words: s.words,
    })),
    chapters,
  });
  return issues.map((issue) => {
    const { segment, chapter, ...rest } = issue as MeetingIssue & {
      segment?: number;
      chapter?: number;
    };
    return {
      ...rest,
      ...(segment !== undefined && { segmentId: segments[segment]!.id }),
      ...(chapter !== undefined && { chapterId: chapters[chapter]!.id }),
    } as Issue;
  });
}
