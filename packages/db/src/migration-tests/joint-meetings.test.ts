import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// See split-munis-into-jurisdictions-and-bodies.test.ts for how migration
// tests work.

const BEFORE = "body-timezone-valid";
const MIGRATION = "joint-meetings";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "before-joint-meetings",
    `
    INSERT INTO jurisdictions (id, name, name_short) VALUES (1, 'Somewhere', 'SW');
    INSERT INTO bodies (id, jurisdiction_id, name_short, timezone) VALUES
      (1, 1, 'AK', 'America/Anchorage'),
      (2, 1, 'NY', 'America/New_York');
    INSERT INTO meetings (id, body_id, site_kind, site_id) VALUES
      (10, 1, 'youtube', 'vid-ak'),
      (11, 2, 'youtube', 'vid-ny');
    `,
  ),
});

describe(MIGRATION, () => {
  test("moves each meeting's body into meeting_bodies, and its timezone onto it", async ({
    testDb,
  }) => {
    const sql = testDb.client;
    expect(await testDb.migrateTo(MIGRATION)).toEqual([
      expect.stringMatching(new RegExp(`_${MIGRATION}$`)),
    ]);

    expect(
      await sql`SELECT meeting_id, body_id FROM meeting_bodies ORDER BY meeting_id`,
    ).toEqual([
      { meeting_id: 10, body_id: 1 },
      { meeting_id: 11, body_id: 2 },
    ]);
    expect(await sql`SELECT id, timezone FROM meetings ORDER BY id`).toEqual([
      { id: 10, timezone: "America/Anchorage" },
      { id: 11, timezone: "America/New_York" },
    ]);
    expect(
      await sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'meetings' AND column_name = 'body_id'`,
    ).toEqual([]);
  });
});
