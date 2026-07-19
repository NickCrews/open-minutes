import { type DB } from "@open-minutes/core/db";

export function getAllMeetings(db: DB) {
  return db.query.meetingsTable.findMany({
    with: { municipality: true },
    orderBy: { start_time: "desc" },
  });
}

export function getMeetingById(db: DB, meetingId: number) {
  return db.query.meetingsTable
    .findFirst({
      where: { id: meetingId },
      with: {
        municipality: true,
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
