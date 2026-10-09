import { type DB, meetingsTable } from "@open-minutes/db";
import { test } from "@open-minutes/db/testing/vitest";
import { describe, expect } from "vitest";
import { getAllMeetings, getMeetingById } from "./index";

async function insertMeeting(db: DB, siteId: string, transcribed: boolean) {
  const [meeting] = await db
    .insert(meetingsTable)
    .values({
      site_kind: "youtube",
      site_id: siteId,
      timezone: "America/Anchorage",
      transcribed_at: transcribed ? new Date() : null,
    })
    .returning({ id: meetingsTable.id });
  return meeting!.id;
}

describe("meetings not yet transcribed", () => {
  test("are hidden from the list and their page", async ({ db }) => {
    const shown = await insertMeeting(db, "a", true);
    const hidden = await insertMeeting(db, "b", false);
    expect((await getAllMeetings(db)).map((m) => m.id)).toEqual([shown]);
    expect((await getMeetingById(db, shown)).id).toBe(shown);
    await expect(getMeetingById(db, hidden)).rejects.toThrow(
      "Meeting not found",
    );
  });
});
