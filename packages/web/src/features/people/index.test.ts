import {
  bodiesTable,
  type DB,
  jurisdictionsTable,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/db";
import { test } from "@open-minutes/db/testing/vitest";
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

/** A meeting's site_kind and site_id are unique, so meetings need distinct IDs. */
let nextSiteId = 0;

/** A meeting of `bodyId` on `date`, with `segments` segments by `personId`. */
async function insertMeeting(
  db: DB,
  bodyId: number,
  date: string | null,
  personId: number | null,
  segments = 1,
) {
  const [meeting] = await db
    .insert(meetingsTable)
    .values({
      body_id: bodyId,
      site_kind: "youtube",
      site_id: `vid${nextSiteId++}`,
      date,
    })
    .returning({ id: meetingsTable.id });
  for (let i = 0; i < segments; i++) {
    await db.insert(segmentsTable).values({
      meeting_id: meeting!.id,
      person_id: personId,
      words: [{ text: "hi", start: i }],
    });
  }
}

describe("getAllPeople attendance", () => {
  test("counts meetings, not segments, and spans first to last", async ({
    db,
  }) => {
    const gbos = await insertBody(db, "GBOS");
    const alice = await insertPerson(db, "Alice");
    await insertMeeting(db, gbos, "2023-04-10", alice, 5);
    await insertMeeting(db, gbos, "2026-02-03", alice, 3);

    const [person] = await getAllPeople(db);
    expect(person!.attendance).toEqual([
      {
        body: "GBOS",
        meetings: 2,
        first: "2023-04-10",
        last: "2026-02-03",
      },
    ]);
  });

  test("splits by body, most-attended first", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    const assembly = await insertBody(db, "Assembly");
    const alice = await insertPerson(db, "Alice");
    await insertMeeting(db, gbos, "2023-04-10", alice);
    await insertMeeting(db, assembly, "2024-01-10", alice);
    await insertMeeting(db, assembly, "2024-06-10", alice);

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
    await insertMeeting(db, gbos, "2023-04-10", null);

    const people = await getAllPeople(db);
    expect(people).toHaveLength(1);
    expect(people[0]!.id).toBe(alice);
    expect(people[0]!.attendance).toEqual([]);
  });

  test("still counts meetings whose date is unknown", async ({ db }) => {
    const gbos = await insertBody(db, "GBOS");
    const alice = await insertPerson(db, "Alice");
    await insertMeeting(db, gbos, null, alice);

    const [person] = await getAllPeople(db);
    expect(person!.attendance).toEqual([
      {
        body: "GBOS",
        meetings: 1,
        first: null,
        last: null,
      },
    ]);
  });
});
