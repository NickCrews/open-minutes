import { type DB, meetingsTable } from "@open-minutes/core/db";
import { eq } from "drizzle-orm";

export function getAllMeetings(db: DB) {
  return db.query.meetingsTable.findMany({
    with: { body: { with: { jurisdiction: true } } },
    orderBy: { start_time: "desc" },
  });
}

/**
 * Sets when a meeting started, or clears it back to unknown. Ingestion can't
 * derive this — YouTube's publish and stream times don't reliably match when
 * the body actually gavelled in — so it arrives from a human reading the video.
 * `start` is a UTC instant; the caller is responsible for having interpreted
 * any wall-clock input in the body's timezone.
 */
export function updateMeetingStartTime(
  db: DB,
  meetingId: number,
  start: Date | null,
) {
  return db
    .update(meetingsTable)
    .set({ start_time: start })
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
          with: { person: { columns: { id: true, name: true } } },
          orderBy: { start_secs: "asc" },
        },
      },
    })
    .then((meeting) => {
      if (!meeting) throw new Error("Meeting not found");
      return meeting;
    });
}
