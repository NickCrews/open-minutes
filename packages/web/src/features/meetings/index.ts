import { type DB, meetingsTable } from "@open-minutes/db";
import type { MeetingWhen } from "@open-minutes/core/meeting-date";
import { eq } from "drizzle-orm";
import { intervalToSecs } from "~/lib/format";

/**
 * Every meeting with a transcript. A meeting is recorded when its video is
 * discovered, before it's transcribed; until then there's nothing to read.
 */
export function getAllMeetings(db: DB) {
  return db.query.meetingsTable.findMany({
    where: { segments: true },
    with: { body: { with: { jurisdiction: true } } },
    orderBy: { date: "desc", time: "desc" },
  });
}

/**
 * Sets when a meeting happened, or clears it back to unknown. Ingestion can't
 * derive this — YouTube's publish and stream times don't reliably match when
 * the body actually gavelled in — so it arrives from a human (or a parser)
 * reading the video or agenda. `date` ("YYYY-MM-DD") and `time` ("HH:MM:SS")
 * are wall-clock readings in the body's timezone; a null `time` means the day
 * is known but the hour isn't. A time without a date is refused by the database.
 */
export function updateMeetingDate(
  db: DB,
  meetingId: number,
  when: MeetingWhen,
) {
  return db
    .update(meetingsTable)
    .set({ date: when.date, time: when.time })
    .where(eq(meetingsTable.id, meetingId));
}

export function getMeetingById(db: DB, meetingId: number) {
  return db.query.meetingsTable
    .findFirst({
      where: { id: meetingId },
      with: {
        body: { with: { jurisdiction: true } },
        segments: {
          // The transcript renders word-by-word synced to video playback, so
          // ship the word-level timestamps and skip the derived text column.
          columns: { text: false },
          // bio feeds the hover card on each speaker's name.
          with: { person: { columns: { id: true, name: true, bio: true } } },
          orderBy: { start_secs: "asc" },
        },
        chapters: {
          columns: { meeting_id: false, generation_id: false },
          orderBy: { start_secs: "asc" },
        },
      },
    })
    .then((meeting) => {
      if (!meeting) throw new Error("Meeting not found");
      return {
        ...meeting,
        // Seconds rather than interval strings: chapters are only ever
        // compared against the playhead.
        chapters: meeting.chapters.map(({ start_secs, end_secs, ...c }) => ({
          ...c,
          start: intervalToSecs(start_secs) ?? 0,
          end: intervalToSecs(end_secs) ?? 0,
        })),
      };
    });
}

/**
 * A meeting's whole transcript, in the same shape as `getMeetingById`'s
 * segments so it renders with the same components. For pages that show a
 * meeting's transcript on demand rather than up front.
 */
export function getMeetingSegments(db: DB, meetingId: number) {
  return db.query.segmentsTable.findMany({
    where: { meeting_id: meetingId },
    columns: { text: false },
    with: { person: { columns: { id: true, name: true, bio: true } } },
    orderBy: { start_secs: "asc" },
  });
}
