import {
  bodiesTable,
  type DB,
  jurisdictionsTable,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/core/db";
import { test } from "@open-minutes/core/db/testing/vitest";
import { N_DIMENSIONS as VOICE_N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { describe, expect } from "vitest";
import { getAllPeople } from "./index";

/** These tests never compare voices; the column is just not-null. */
const NO_VOICE = Array.from({ length: VOICE_N_DIMENSIONS }, () => 0);

async function insertBody(db: DB, name_short: string): Promise<number> {
  const [jurisdiction] = await db
    .insert(jurisdictionsTable)
    .values({ name: "Testville" })
    .returning({ id: jurisdictionsTable.id });
  const [body] = await db
    .insert(bodiesTable)
    .values({
      name: name_short,
      name_short,
      jurisdiction_id: jurisdiction!.id,
      timezone: "America/Anchorage",
    })
    .returning({ id: bodiesTable.id });
  return body!.id;
}

async function insertPerson(db: DB, name: string): Promise<number> {
  const [person] = await db
    .insert(peopleTable)
    .values({ name, voice_embedding: NO_VOICE })
    .returning({ id: peopleTable.id });
  return person!.id;
}

/** youtube_id is unique and defaults to "", so meetings need distinct ones. */
let nextYoutubeId = 0;

/** A meeting of `bodyId` at `start`, with `segments` segments by `personId`. */
async function insertMeeting(
  db: DB,
  bodyId: number,
  start: string | null,
  personId: number | null,
  segments = 1,
) {
  const [meeting] = await db
    .insert(meetingsTable)
    .values({
      body_id: bodyId,
      youtube_id: `vid${nextYoutubeId++}`,
      start_time: start ? new Date(start) : null,
    })
    .returning({ id: meetingsTable.id });
  for (let i = 0; i < segments; i++) {
    await db.insert(segmentsTable).values({
      meeting_id: meeting!.id,
      person_id: personId,
      words: [{ text: "hi", start: i, end: i + 1 }],
    });
  }
}

describe("getAllPeople attendance", () => {
  test("counts meetings, not segments, and spans first to last", async ({
    db,
  }) => {
    const gbos = await insertBody(db, "GBOS");
    const alice = await insertPerson(db, "Alice");
    await insertMeeting(db, gbos, "2023-04-10T18:00:00Z", alice, 5);
    await insertMeeting(db, gbos, "2026-02-03T18:00:00Z", alice, 3);

    const [person] = await getAllPeople(db);
    expect(person!.attendance).toEqual([
      {
        body: "GBOS",
        timezone: "America/Anchorage",
        meetings: 2,
        first: new Date("2023-04-10T18:00:00Z"),
        last: new Date("2026-02-03T18:00:00Z"),
      },
    ]);
  });

  test("splits by body, most-attended first", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    const assembly = await insertBody(db, "Assembly");
    const alice = await insertPerson(db, "Alice");
    await insertMeeting(db, gbos, "2023-04-10T18:00:00Z", alice);
    await insertMeeting(db, assembly, "2024-01-10T18:00:00Z", alice);
    await insertMeeting(db, assembly, "2024-06-10T18:00:00Z", alice);

    const [person] = await getAllPeople(db);
    expect(person!.attendance.map((a) => [a.body, a.meetings])).toEqual([
      ["Assembly", 2],
      ["GBOS", 1],
    ]);
  });

  test("gives a person with no segments an empty record", async ({ db }) => {
    await insertPerson(db, "Alice");
    const [person] = await getAllPeople(db);
    expect(person!.attendance).toEqual([]);
  });

  test("ignores unidentified segments rather than grouping them as a person", async ({
    db,
  }) => {
    const gbos = await insertBody(db, "GBOS");
    const alice = await insertPerson(db, "Alice");
    await insertMeeting(db, gbos, "2023-04-10T18:00:00Z", null);

    const people = await getAllPeople(db);
    expect(people).toHaveLength(1);
    expect(people[0]!.id).toBe(alice);
    expect(people[0]!.attendance).toEqual([]);
  });

  test("still counts meetings whose start time is unknown", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    const alice = await insertPerson(db, "Alice");
    await insertMeeting(db, gbos, null, alice);

    const [person] = await getAllPeople(db);
    expect(person!.attendance).toEqual([
      {
        body: "GBOS",
        timezone: "America/Anchorage",
        meetings: 1,
        first: null,
        last: null,
      },
    ]);
  });
});
