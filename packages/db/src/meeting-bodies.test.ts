import { describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { test } from "./testing/vitest";
import {
  bodiesTable,
  jurisdictionsTable,
  meetingBodiesTable,
  meetingsTable,
} from "./schema";

describe("meeting_bodies", () => {
  test("goes with its meeting when the meeting is deleted", async ({ db }) => {
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

    await db.delete(meetingsTable).where(eq(meetingsTable.id, meeting!.id));

    expect(await db.select().from(meetingBodiesTable)).toEqual([]);
    // The bodies themselves stay.
    expect(await db.select().from(bodiesTable)).toHaveLength(2);
  });
});
