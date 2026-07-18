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
          // words is the bulky word-level jsonb; the derived text column is
          // all the UI needs.
          columns: { words: false },
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
