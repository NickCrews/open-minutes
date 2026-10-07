import { eq } from "drizzle-orm";
import { meetingBodiesTable, meetingsTable } from "@open-minutes/db";
import {
  checkMeeting as checkMeetingData,
  type IssueCode,
} from "@open-minutes/core/meeting-check";
import { type Db, ToolError } from "./tool";
import { intervalSecs, loadChapters, loadSegments } from "./load";

/** Something wrong, or probably wrong, with a meeting's data. */
export interface Issue {
  /** error: the data is wrong. warning: probably wrong, or a broken convention. */
  severity: "error" | "warning";
  code: IssueCode;
  message: string;
  segmentId?: number;
  chapterId?: number;
  /** Seconds into the meeting, where the problem is. */
  at?: number;
}

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

  const issues = checkMeetingData({
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
  return issues.map(({ code, severity, message, segment, chapter, at }) => ({
    severity,
    code,
    message,
    ...(segment !== undefined && { segmentId: segments[segment]!.id }),
    ...(chapter !== undefined && { chapterId: chapters[chapter]!.id }),
    ...(at !== undefined && { at }),
  }));
}
