import {
  bodiesTable,
  type DB,
  jurisdictionsTable,
  meetingCohostsTable,
  meetingsTable,
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

/** A meeting's site_kind and site_id are unique, so meetings need distinct IDs. */
let nextSiteId = 0;

async function insertMeeting(
  db: DB,
  bodyId: number,
  date: string | null,
  cohosts: number[] = [],
): Promise<number> {
  const [meeting] = await db
    .insert(meetingsTable)
    .values({
      body_id: bodyId,
      site_kind: "youtube",
      site_id: `vid${nextSiteId++}`,
      date,
    })
    .returning({ id: meetingsTable.id });
  if (cohosts.length)
    await db
      .insert(meetingCohostsTable)
      .values(cohosts.map((body_id) => ({ meeting_id: meeting!.id, body_id })));
  return meeting!.id;
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

  test("counts a joint meeting for every body that held it", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    const luc = await insertBody(db, "LUC");
    await insertMeeting(db, gbos, "2022-01-01");
    await insertMeeting(db, gbos, "2022-08-30", [luc]);

    const coverage = new Map(
      (await getAllBodies(db)).map((b) => [b.id, b.coverage]),
    );
    expect(coverage.get(gbos)).toEqual({
      meetings: 2,
      first: "2022-01-01",
      last: "2022-08-30",
    });
    expect(coverage.get(luc)).toEqual({
      meetings: 1,
      first: "2022-08-30",
      last: "2022-08-30",
    });
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

describe("getBodyById", () => {
  test("lists the body's own meetings and its joint ones, newest first", async ({
    db,
  }) => {
    const gbos = await insertBody(db, "GBOS");
    const luc = await insertBody(db, "LUC");
    const assembly = await insertBody(db, "Assembly");
    const own = await insertMeeting(db, luc, "2022-01-01");
    const joint = await insertMeeting(db, gbos, "2022-08-30", [luc]);
    await insertMeeting(db, gbos, "2022-09-01");
    await insertMeeting(db, assembly, "2022-09-01");

    const body = await getBodyById(db, luc);
    expect(
      body.meetings.map((m) => ({
        id: m.id,
        host: m.body.id,
        cohosts: m.cohosts.map((c) => c.id),
      })),
    ).toEqual([
      { id: joint, host: gbos, cohosts: [luc] },
      { id: own, host: luc, cohosts: [] },
    ]);
  });
});
