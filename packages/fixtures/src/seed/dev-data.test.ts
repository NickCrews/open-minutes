import { describe, expect, test as plainTest } from "vitest";
import { sql } from "drizzle-orm";
import { meetingsTable, peopleTable, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { devData, loadDevSnapshot, placeholderVoiceprint } from "./dev-data";

const snapshot = loadDevSnapshot();
const test = dbTest({ data: devData });

describe("devData", () => {
  test("seeds every golden and dev-data meeting, with transcripts", async ({
    db,
  }) => {
    const meetings = await db.select().from(meetingsTable);
    expect(meetings.map((m) => m.youtube_id).sort()).toEqual(
      snapshot.meetings.map((m) => m.youtube_id).sort(),
    );
    const [{ n }] = (await db.execute(
      sql`SELECT count(DISTINCT meeting_id)::int AS n FROM ${segmentsTable}`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(snapshot.meetings.length);
  });

  test("links identified speakers to people, with bios where given", async ({
    db,
  }) => {
    const people = await db
      .select({ slug: peopleTable.slug, bio: peopleTable.bio })
      .from(peopleTable);
    const dana = people.find((p) => p.slug === "dana-example");
    expect(dana?.bio).toMatch(/Chair/);
    const attributed = await db.execute(
      sql`SELECT 1 FROM ${segmentsTable} WHERE person_id IS NOT NULL LIMIT 1`,
    );
    expect(attributed).toHaveLength(1);
  });

  test("leaves sequences past the seeded ids, so the app can insert", async ({
    db,
  }) => {
    const [row] = await db
      .insert(meetingsTable)
      .values({ body_id: 1, youtube_id: "new-one" })
      .returning({ id: meetingsTable.id });
    expect(row!.id).toBe(snapshot.meetings.length + 1);
  });
});

describe("placeholderVoiceprint", () => {
  plainTest("is a stable, distinct unit vector per person", () => {
    const a = placeholderVoiceprint("a");
    expect(placeholderVoiceprint("a")).toEqual(a);
    expect(placeholderVoiceprint("b")).not.toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
  });
});
