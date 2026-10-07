import { describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { test } from "./testing/vitest";
import {
  bodiesTable,
  jurisdictionsTable,
  meetingCohostsTable,
  meetingsTable,
} from "./schema";

describe("meeting_cohosts", () => {
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
      .values({ body_id: gbos!.id, site_kind: "youtube", site_id: "joint" })
      .returning({ id: meetingsTable.id });
    await db
      .insert(meetingCohostsTable)
      .values({ meeting_id: meeting!.id, body_id: luc!.id });

    await db.delete(meetingsTable).where(eq(meetingsTable.id, meeting!.id));

    expect(await db.select().from(meetingCohostsTable)).toEqual([]);
    // The body itself stays.
    expect(await db.select().from(bodiesTable)).toHaveLength(2);
  });
});
