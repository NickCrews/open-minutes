import { describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { test } from "./testing/vitest";
import type { DB } from "./index";
import {
  bodiesTable,
  jurisdictionsTable,
  meetingBodiesTable,
  meetingsTable,
} from "./schema";

/** A joint meeting of GBOS and LUC. */
async function insertJointMeeting(db: DB) {
  const [jurisdiction] = await db
    .insert(jurisdictionsTable)
    .values({ name: "Girdwood" })
    .returning({ id: jurisdictionsTable.id });
  const [gbos, luc] = await db
    .insert(bodiesTable)
    .values(
      ["GBOS", "LUC"].map((name_short) => ({
        name_short,
        jurisdiction_id: jurisdiction!.id,
        timezone: "America/Anchorage",
      })),
    )
    .returning({ id: bodiesTable.id });
  const [meeting] = await db
    .insert(meetingsTable)
    .values({
      site_kind: "youtube",
      site_id: "joint",
      timezone: "America/Anchorage",
    })
    .returning({ id: meetingsTable.id });
  await db
    .insert(meetingBodiesTable)
    .values(
      [gbos!, luc!].map((b) => ({ meeting_id: meeting!.id, body_id: b.id })),
    );
  return { gbos: gbos!.id, luc: luc!.id, meeting: meeting!.id };
}

describe("meeting_bodies", () => {
  test("goes with its meeting when the meeting is deleted", async ({ db }) => {
    const { meeting } = await insertJointMeeting(db);

    await db.delete(meetingsTable).where(eq(meetingsTable.id, meeting));

    expect(await db.select().from(meetingBodiesTable)).toEqual([]);
    // The bodies themselves stay.
    expect(await db.select().from(bodiesTable)).toHaveLength(2);
  });

  test("goes with its body when the body is deleted", async ({ db }) => {
    const { gbos, luc, meeting } = await insertJointMeeting(db);

    await db.delete(bodiesTable).where(eq(bodiesTable.id, luc));

    expect(
      await db
        .select({ body_id: meetingBodiesTable.body_id })
        .from(meetingBodiesTable),
    ).toEqual([{ body_id: gbos }]);
    // The meeting itself stays.
    expect(
      await db
        .select()
        .from(meetingsTable)
        .where(eq(meetingsTable.id, meeting)),
    ).toHaveLength(1);
  });
});
