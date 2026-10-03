import {
  bodiesTable,
  type DB,
  jurisdictionsTable,
  meetingsTable,
  segmentsTable,
} from "@open-minutes/db";
import { test } from "@open-minutes/db/testing/vitest";
import { describe, expect } from "vitest";
import { getAllBodies, getBodyById } from "./index";

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

/** A meeting, transcribed (one segment) unless `transcribed` is false. */
async function insertMeeting(
  db: DB,
  bodyId: number,
  date: string | null,
  { transcribed = true } = {},
) {
  const [meeting] = await db
    .insert(meetingsTable)
    .values({ body_id: bodyId, youtube_id: `vid${nextYoutubeId++}`, date })
    .returning({ id: meetingsTable.id });
  if (transcribed) {
    await db.insert(segmentsTable).values({
      meeting_id: meeting!.id,
      words: [{ text: "Hello", start: 0 }],
    });
  }
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

  test("leaves out meetings not transcribed yet", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    await insertMeeting(db, gbos, "2026-02-03");
    await insertMeeting(db, gbos, "2026-09-01", { transcribed: false });
    const [body] = await getAllBodies(db);
    expect(body!.coverage).toEqual({
      meetings: 1,
      first: "2026-02-03",
      last: "2026-02-03",
    });
  });

  test("leaves the span unknown when no meeting has a date", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    await insertMeeting(db, gbos, null);
    const [body] = await getAllBodies(db);
    expect(body!.coverage).toEqual({ meetings: 1, first: null, last: null });
  });
});

describe("untranscribed meetings", () => {
  test("aren't listed on their body's page", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    await insertMeeting(db, gbos, "2026-02-03");
    await insertMeeting(db, gbos, "2026-09-01", { transcribed: false });

    const body = await getBodyById(db, gbos);
    expect(body.meetings.map((m) => m.date)).toEqual(["2026-02-03"]);
  });
});
