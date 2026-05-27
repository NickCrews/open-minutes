import { type DB, meetingsTable } from "@open-minutes/core/db";

export function getAllMeetings(db: DB) {
  return db.select().from(meetingsTable);
}

export function getMeetingById(db: DB, meetingId: number) {
  return db.query.meetingsTable
    .findFirst({
      where: { id: meetingId },
    })
    .then((meeting) => {
      if (!meeting) throw new Error("Meeting not found");
      return meeting;
    });
}
