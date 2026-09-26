import {
  bodiesTable,
  type DB,
  jurisdictionsTable,
  meetingsTable,
} from "@open-minutes/core/db";
import { test } from "@open-minutes/core/db/testing/vitest";
import { describe, expect } from "vitest";
import { getAllBodies } from "./index";

async function insertBody(db: DB, name: string): Promise<number> {
  const [jurisdiction] = await db
    .insert(jurisdictionsTable)
    .values({ name: "Testville" })
    .returning({ id: jurisdictionsTable.id });
  const [body] = await db
    .insert(bodiesTable)
    .values({
      name,
      name_short: name,
      jurisdiction_id: jurisdiction!.id,
      timezone: "America/Anchorage",
    })
    .returning({ id: bodiesTable.id });
  return body!.id;
}

/** youtube_id is unique and defaults to "", so meetings need distinct ones. */
let nextYoutubeId = 0;

async function insertMeeting(db: DB, bodyId: number, start: string | null) {
  await db.insert(meetingsTable).values({
    body_id: bodyId,
    youtube_id: `vid${nextYoutubeId++}`,
    start_time: start ? new Date(start) : null,
  });
}

describe("getAllBodies coverage", () => {
  test("counts each body's meetings and spans first to last", async ({
    db,
  }) => {
    const assembly = await insertBody(db, "Assembly");
    const gbos = await insertBody(db, "GBOS");
    await insertMeeting(db, gbos, "2026-02-03T18:00:00Z");
    await insertMeeting(db, gbos, "2023-04-10T18:00:00Z");
    await insertMeeting(db, gbos, null);
    await insertMeeting(db, assembly, "2024-01-10T18:00:00Z");

    const bodies = await getAllBodies(db);
    expect(bodies.map((b) => [b.id, b.coverage])).toEqual([
      [
        assembly,
        {
          meetings: 1,
          first: new Date("2024-01-10T18:00:00Z"),
          last: new Date("2024-01-10T18:00:00Z"),
        },
      ],
      [
        gbos,
        {
          // The undated meeting still counts; it just can't bound the span.
          meetings: 3,
          first: new Date("2023-04-10T18:00:00Z"),
          last: new Date("2026-02-03T18:00:00Z"),
        },
      ],
    ]);
  });

  test("gives a body with no meetings zero coverage", async ({ db }) => {
    await insertBody(db, "GBOS");
    const [body] = await getAllBodies(db);
    expect(body!.coverage).toEqual({ meetings: 0, first: null, last: null });
  });

  test("leaves the span unknown when no meeting has a start time", async ({
    db,
  }) => {
    const gbos = await insertBody(db, "GBOS");
    await insertMeeting(db, gbos, null);
    const [body] = await getAllBodies(db);
    expect(body!.coverage).toEqual({ meetings: 1, first: null, last: null });
  });
});
