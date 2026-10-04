import { describe, expect } from "vitest";
import { sql } from "drizzle-orm";
import { meetingsTable, peopleTable, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { goldenMeetingsData } from "./golden-meetings-data";

// Seeding a golden computes a voiceprint per identified person, from the
// meeting's audio. That audio comes from the object store, so the cold path
// is ~10 MB to download and some seconds to decode and embed; after that the
// harness caches the seeded database as a template. The shortest golden keeps
// the cold path short. Tests that don't need the database belong in
// golden-meetings-data.fingerprint.test.ts, so they don't wait on the audio.
const SLUG = "pzc_DwFHRjobjcY";

const test = dbTest({
  data: goldenMeetingsData([SLUG]),
  // ~10 s on CI, cold. Every golden's audio is in the store; a miss waits on
  // a fetch-youtube-audio run, which can take longer than this.
  setupTimeoutMs: 5 * 60_000,
});

describe("goldenMeetingsData", () => {
  test("seeds the golden rows, the meeting's transcript, and voiceprints", async ({
    db,
  }) => {
    const meeting = getMeetingData(SLUG);
    const meetings = await db.select().from(meetingsTable);
    expect(meetings.map((m) => m.youtube_id)).toEqual([meeting.youtube_id]);

    const [row] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM ${segmentsTable}`,
    )) as unknown as [{ n: number }];
    expect(row.n).toBe(
      meeting.segments.filter((s) => s.words.length > 0).length,
    );

    // "golden" seeds no people, so each person here was voiceprinted from
    // this meeting's audio.
    const identified = new Set(
      meeting.segments.flatMap((s) =>
        s.speaker.kind === "identified" ? [s.speaker.person] : [],
      ),
    );
    const people = await db
      .select({ slug: peopleTable.slug })
      .from(peopleTable);
    expect(people.length).toBeGreaterThan(0);
    for (const { slug } of people) expect(identified).toContain(slug);
  });
});
