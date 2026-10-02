import { describe, expect, test as plainTest } from "vitest";
import { sql } from "drizzle-orm";
import {
  chapterGenerationsTable,
  chaptersTable,
  chapterSpeakersView,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { devData, loadDevSnapshot, placeholderVoiceprint } from "./dev-data";

const snapshot = loadDevSnapshot();
const test = dbTest({ data: devData });

describe("devData", () => {
  test("seeds every golden meeting, with transcripts", async ({ db }) => {
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
    const bray = people.find((p) => p.slug === "bray-keefer");
    expect(bray?.bio).toMatch(/Landscape architect/);
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

describe("devData chapters", () => {
  const chaptered = snapshot.meetings.findIndex((m) => m.chapters);
  const meetingId = chaptered + 1;
  const golden = snapshot.meetings[chaptered]!.chapters!;

  test("seeds a golden meeting's chapters, in order, with provenance", async ({
    db,
  }) => {
    const meeting = await db.query.meetingsTable.findFirst({
      where: { id: meetingId },
      with: {
        chapters: {
          orderBy: { start_secs: "asc" },
          with: { generation: true },
        },
      },
    });
    expect(meeting!.chapters.map((c) => c.title)).toEqual(
      golden.chapters.map((c) => c.title),
    );
    expect(meeting!.chapters[0]!.generation).toMatchObject(golden.generation);
    expect(meeting!.chapters[1]!.bullets).toEqual(golden.chapters[1]!.bullets);
  });

  test("derives who spoke in each chapter, clipped to the chapter", async ({
    db,
  }) => {
    const rows = (await db.execute(sql`
      SELECT c.id,
        extract(epoch FROM c.end_secs - c.start_secs)::float8 AS chapter_secs,
        extract(epoch FROM sum(v.speaking_secs))::float8 AS spoken_secs,
        count(*)::int AS speakers
      FROM ${chaptersTable} c
      JOIN ${chapterSpeakersView} v ON v.chapter_id = c.id
      WHERE c.meeting_id = ${meetingId}
      GROUP BY c.id`)) as unknown as {
      chapter_secs: number;
      spoken_secs: number;
      speakers: number;
    }[];
    // Every chapter has speech, and the speech fits inside the chapter.
    expect(rows).toHaveLength(golden.chapters.length);
    for (const r of rows) {
      expect(r.spoken_secs).toBeGreaterThan(0);
      expect(r.spoken_secs).toBeLessThanOrEqual(r.chapter_secs + 0.001);
    }
    // The long roads report is nearly all one speaker.
    const [top] = (await db.execute(sql`
      SELECT p.slug FROM ${chapterSpeakersView} v
      JOIN ${chaptersTable} c ON c.id = v.chapter_id
      JOIN ${peopleTable} p ON p.id = v.person_id
      WHERE c.title = 'Roads report: overflow, steaming and breakup'
      ORDER BY v.speaking_secs DESC LIMIT 1`)) as unknown as { slug: string }[];
    expect(top!.slug).toBe("kyle-kelley");
  });

  test("refuses overlapping chapters in one meeting", async ({ db }) => {
    const [first] = await db
      .select()
      .from(chaptersTable)
      .where(sql`${chaptersTable.meeting_id} = ${meetingId}`)
      .orderBy(chaptersTable.start_secs)
      .limit(1);
    await expect(
      db.insert(chaptersTable).values({
        ...first!,
        id: undefined,
        title: "Overlaps the first chapter",
      }),
    ).rejects.toThrow();
  });

  test("refuses a chapter whose generation is another meeting's", async ({
    db,
  }) => {
    const [generation] = await db.select().from(chapterGenerationsTable);
    const otherMeeting = generation!.meeting_id === 1 ? 2 : 1;
    await expect(
      db.insert(chaptersTable).values({
        meeting_id: otherMeeting,
        generation_id: generation!.id,
        start_secs: "00:00:01",
        end_secs: "00:00:02",
        title: "Wrong meeting",
        summary: "Nope.",
      }),
    ).rejects.toThrow();
  });

  test.for([
    { title: " ", summary: "S.", bullets: [] },
    { title: "T", summary: "", bullets: [] },
    { title: "T", summary: "S.", bullets: ["fine", ""] },
  ])("refuses blank chapter text: %j", async (text, { db }) => {
    const [generation] = await db.select().from(chapterGenerationsTable);
    await expect(
      db.insert(chaptersTable).values({
        meeting_id: generation!.meeting_id,
        generation_id: generation!.id,
        start_secs: "05:00:01",
        end_secs: "05:00:02",
        ...text,
      }),
    ).rejects.toThrow();
  });

  test("refuses a chapter that ends before it starts", async ({ db }) => {
    const [generation] = await db.select().from(chapterGenerationsTable);
    await expect(
      db.insert(chaptersTable).values({
        meeting_id: generation!.meeting_id,
        generation_id: generation!.id,
        start_secs: "05:00:02",
        end_secs: "05:00:01",
        title: "Backwards",
        summary: "Nope.",
      }),
    ).rejects.toThrow();
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
