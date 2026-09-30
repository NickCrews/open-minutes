import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// This migration's own comment is the reason for this test: the generated cast
// read naive start_times in the *session's* TimeZone, so the result depended on
// who ran it, and "a migration that is only correct on empty data isn't
// correct". Every start_time was null when it shipped, so it had never run on
// real values. Here it does, under a non-UTC session zone.

const BEFORE = "split-munis-into-jurisdictions-and-bodies";
const MIGRATION = "body-timezone-and-instant-start-time";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "naive-start-times",
    `
    INSERT INTO jurisdictions (id, name, name_short) VALUES (1, 'Municipality of Anchorage', 'MOA');
    INSERT INTO bodies (id, jurisdiction_id, name, name_short) VALUES (1, 1, 'Girdwood Board of Supervisors', 'GBOS');
    -- Drizzle wrote this column as naive UTC: 03:00 UTC is 7pm the previous
    -- evening in Anchorage.
    INSERT INTO meetings (body_id, youtube_id, start_time) VALUES
      (1, 'has-start', '2026-03-24 03:00:00'),
      (1, 'no-start', NULL);
    `,
  ),
});

describe(MIGRATION, () => {
  test("keeps each start_time's instant, whatever the session's time zone", async ({
    testDb,
  }) => {
    // Every connection the migration opens now defaults to Anchorage time, so
    // a bare ::timestamptz cast would shift the instant by nine hours.
    await testDb.client.unsafe(
      `ALTER DATABASE "${testDb.name}" SET timezone TO 'America/Anchorage'`,
    );

    await testDb.migrateTo(MIGRATION);

    const rows = await testDb.client`
      SELECT youtube_id, extract(epoch FROM start_time)::bigint AS epoch
      FROM meetings ORDER BY youtube_id`;
    expect(rows).toEqual([
      {
        youtube_id: "has-start",
        epoch: String(Date.parse("2026-03-24T03:00:00Z") / 1000),
      },
      { youtube_id: "no-start", epoch: null },
    ]);

    const [column] = await testDb.client`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'meetings' AND column_name = 'start_time'`;
    expect(column!.data_type).toBe("timestamp with time zone");
  });

  test("backfills existing bodies' time zone, then requires one", async ({
    testDb,
  }) => {
    await testDb.migrateTo(MIGRATION);
    const sql = testDb.client;
    expect(await sql`SELECT name_short, timezone FROM bodies`).toEqual([
      { name_short: "GBOS", timezone: "America/Anchorage" },
    ]);
    await expect(
      sql`INSERT INTO bodies (jurisdiction_id, name_short) VALUES (1, 'No Zone')`,
    ).rejects.toThrow(/timezone/);
  });
});
