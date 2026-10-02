import { describe, expect } from "vitest";
import { sql } from "drizzle-orm";
import { meetingsTable, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { goldenMeetingsData } from "./golden-meetings-data";

// Every golden has identified speakers, so seeding one computes voiceprints
// from the meeting's full audio. That makes every test in this file slow.
// dbTest seeds in a module-level beforeAll, which vitest skips when no test in
// the file runs, so the fast suite never fetches the audio. Tests that don't
// need the database belong in golden-meetings-data.fingerprint.test.ts.
const SLUG = "gbos_hTKVG_L61ec";

const test = dbTest({
  data: goldenMeetingsData([SLUG]),
  setupTimeoutMs: 60 * 60_000,
});

describe("goldenMeetingsData", () => {
  test(
    "seeds the golden rows plus the meetings' transcripts",
    { tags: ["slow"] },
    async ({ db }) => {
      const meeting = getMeetingData(SLUG);
      const meetings = await db.select().from(meetingsTable);
      expect(meetings.map((m) => m.youtube_id)).toEqual([meeting.youtube_id]);

      const [row] = (await db.execute(
        sql`SELECT count(*)::int AS n FROM ${segmentsTable}`,
      )) as unknown as [{ n: number }];
      expect(row.n).toBe(
        meeting.segments.filter((s) => s.words.length > 0).length,
      );
    },
  );
});
