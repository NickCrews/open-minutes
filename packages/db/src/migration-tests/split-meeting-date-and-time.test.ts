import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// The backfill is hand-written: each start_time is an instant, and has to become
// the wall clock of its *body's* zone (not UTC, not the session's) before it is
// split into a date and a time. Every start_time was null when this shipped, so
// it had never run on real values. Here it does, under a session zone that
// matches neither body.

const BEFORE = "charming_riptide";
const MIGRATION = "split-meeting-date-and-time";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "instant-start-times",
    `
    INSERT INTO jurisdictions (id, name, name_short) VALUES (1, 'Somewhere', 'SW');
    INSERT INTO bodies (id, jurisdiction_id, name, name_short, timezone) VALUES
      (1, 1, 'Anchorage Board', 'AK', 'America/Anchorage'),
      (2, 1, 'New York Board', 'NY', 'America/New_York');
    INSERT INTO meetings (body_id, youtube_id, start_time) VALUES
      -- 03:00 UTC is 7pm the previous evening in Anchorage (AKDT, -8).
      (1, 'ak-evening', '2026-03-24T03:00:00Z'),
      -- The same instant is 11pm the previous evening in New York (EDT, -4).
      (2, 'ny-late', '2026-03-24T03:00:00Z'),
      (1, 'no-start', NULL);
    `,
  ),
});

describe(MIGRATION, () => {
  test("splits each start_time into its body's local date and time", async ({
    testDb,
  }) => {
    await testDb.client.unsafe(
      `ALTER DATABASE "${testDb.name}" SET timezone TO 'Asia/Tokyo'`,
    );

    await testDb.migrateTo(MIGRATION);

    const rows = await testDb.client`
      SELECT youtube_id, date::text AS date, time::text AS time
      FROM meetings ORDER BY youtube_id`;
    expect(rows).toEqual([
      { youtube_id: "ak-evening", date: "2026-03-23", time: "19:00:00" },
      { youtube_id: "no-start", date: null, time: null },
      { youtube_id: "ny-late", date: "2026-03-23", time: "23:00:00" },
    ]);
  });

  test("drops start_time and refuses a time without a date", async ({
    testDb,
  }) => {
    await testDb.migrateTo(MIGRATION);
    const sql = testDb.client;

    const columns = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'meetings' AND column_name = 'start_time'`;
    expect(columns).toEqual([]);

    await expect(
      sql`INSERT INTO meetings (body_id, youtube_id, time) VALUES (1, 'x', '19:00')`,
    ).rejects.toThrow(/meetings_time_requires_date/);
  });
});
