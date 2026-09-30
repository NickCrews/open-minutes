import { describe, expect, test as plainTest } from "vitest";
import { sql } from "drizzle-orm";
import { meetingsTable, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { goldenMeetingsData } from "./golden-meetings-data";

// Uses a golden meeting with no *identified* speakers, which seeds without
// touching audio (voiceprints are only computed for identified people), so the
// dataset's whole path runs in the fast suite. The e2e test uses the same
// dataset with meetings that do need audio.
const TRANSCRIPT_ONLY = "gbos_hTKVG_L61ec";

const test = dbTest({ data: goldenMeetingsData([TRANSCRIPT_ONLY]) });

describe("goldenMeetingsData", () => {
  test("seeds the golden rows plus the meetings' transcripts", async ({
    db,
  }) => {
    const meeting = getMeetingData(TRANSCRIPT_ONLY);
    const meetings = await db.select().from(meetingsTable);
    expect(meetings.map((m) => m.youtube_id)).toEqual([meeting.youtube_id]);

    const [row] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM ${segmentsTable}`,
    )) as unknown as [{ n: number }];
    expect(row.n).toBe(
      meeting.segments.filter((s) => s.words.length > 0).length,
    );
  });

  plainTest("fingerprints differ per meeting set, and are stable", () => {
    const a = goldenMeetingsData(["gbos_9HoIM5INxpI"]).fingerprint;
    expect(goldenMeetingsData(["gbos_9HoIM5INxpI"]).fingerprint).toBe(a);
    expect(goldenMeetingsData([TRANSCRIPT_ONLY]).fingerprint).not.toBe(a);
  });
});
