import { describe, expect } from "vite-plus/test";
import { sql } from "drizzle-orm";
import { meetingsTable, peopleTable, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { getMeetingData } from "@open-minutes/datasets/datums";
import { loadDataset } from "@open-minutes/datasets";
import { datasetState } from "./index";

// Seeding with real voiceprints computes a voiceprint per identified person, from the
// meeting's audio. That audio comes from the blob store, so the cold path
// is ~10 MB to download and some seconds to decode and embed; after that the
// harness caches the seeded database as a template. The dataset's one meeting
// is the shortest golden, which keeps the cold path short. Tests that don't
// need the database belong in fingerprint.test.ts, so they don't wait on the audio.
const [SLUG] = loadDataset("quick-voiceprints").meetings as [string];

const test = dbTest({
  data: datasetState("quick-voiceprints"),
  // ~10 s on CI, cold. Every golden's audio is in the store; a miss waits on
  // a fetch-youtube-audio run, which can take longer than this.
  setupTimeoutMs: 5 * 60_000,
});

describe("audio voiceprints", () => {
  test("seeds the meeting's transcript, and its speakers with voiceprints", async ({
    db,
  }) => {
    const meeting = getMeetingData(SLUG);
    const meetings = await db.select().from(meetingsTable);
    expect(meetings.map((m) => m.site_id)).toEqual([meeting.youtube_id]);
    expect(meetings.map((m) => m.slug)).toEqual([SLUG]);

    const [row] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM ${segmentsTable}`,
    )) as unknown as [{ n: number }];
    expect(row.n).toBe(
      meeting.segments.filter((s) => s.words.length > 0).length,
    );

    // The dataset seeds only speakers, so each person here was voiceprinted
    // from this meeting's audio.
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
