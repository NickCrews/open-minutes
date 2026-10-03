import {
  bodiesTable,
  type DB,
  jurisdictionsTable,
  meetingsTable,
} from "@open-minutes/db";
import { test } from "@open-minutes/db/testing/vitest";
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

async function insertMeeting(db: DB, bodyId: number, date: string | null) {
  await db.insert(meetingsTable).values({
    body_id: bodyId,
    youtube_id: `vid${nextYoutubeId++}`,
    date,
  });
}

describe("getAllBodies coverage", () => {
  test("counts each body's meetings and spans first to last", async ({
    db,
  }) => {
    const assembly = await insertBody(db, "Assembly");
    const gbos = await insertBody(db, "GBOS");
    await insertMeeting(db, gbos, "2026-02-03");
    await insertMeeting(db, gbos, "2023-04-10");
    await insertMeeting(db, gbos, null);
    await insertMeeting(db, assembly, "2024-01-10");

    const bodies = await getAllBodies(db);
    expect(bodies.map((b) => [b.id, b.coverage])).toEqual([
      [
        assembly,
        {
          meetings: 1,
          first: "2024-01-10",
          last: "2024-01-10",
        },
      ],
      [
        gbos,
        {
          // The undated meeting still counts; it just can't bound the span.
          meetings: 3,
          first: "2023-04-10",
          last: "2026-02-03",
        },
      ],
    ]);
  });

  test("gives a body with no meetings zero coverage", async ({ db }) => {
    await insertBody(db, "GBOS");
    const [body] = await getAllBodies(db);
    expect(body!.coverage).toEqual({ meetings: 0, first: null, last: null });
  });

  test("leaves the span unknown when no meeting has a date", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    await insertMeeting(db, gbos, null);
    const [body] = await getAllBodies(db);
    expect(body!.coverage).toEqual({ meetings: 1, first: null, last: null });
  });
});

describe("getAllBodies thumbnail", () => {
  test("uses the most recent meeting that has a video", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    const empty = await insertBody(db, "Empty");
    await insertMeeting(db, gbos, "2023-04-10");
    await insertMeeting(db, gbos, null);
    await insertMeeting(db, gbos, "2026-02-03");
    const latest = `vid${nextYoutubeId - 1}`;
    await db
      .insert(meetingsTable)
      .values({ body_id: gbos, youtube_id: "", date: "2027-01-01" });

    const bodies = await getAllBodies(db);
    expect(
      Object.fromEntries(bodies.map((b) => [b.id, b.thumbnail_youtube_id])),
    ).toEqual({ [gbos]: latest, [empty]: null });
  });
});
