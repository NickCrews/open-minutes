import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// See split-munis-into-jurisdictions-and-bodies.test.ts for how migration
// tests work.

const BEFORE = "joint-meetings";
const MIGRATION = "meeting-transcribed-at";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "before-meeting-transcribed-at",
    `
    INSERT INTO meetings (id, site_kind, site_id, timezone, created_at) VALUES
      (10, 'youtube', 'vid-a', 'America/Anchorage', '2026-09-01 12:00:00'),
      (11, 'youtube', 'vid-b', 'America/Anchorage', '2026-10-02 08:30:00');
    `,
  ),
});

describe(MIGRATION, () => {
  test("marks every existing meeting transcribed when it was created", async ({
    testDb,
  }) => {
    const sql = testDb.client;
    expect(await testDb.migrateTo(MIGRATION)).toEqual([
      expect.stringMatching(new RegExp(`_${MIGRATION}$`)),
    ]);
    expect(
      await sql`SELECT id, transcribed_at = created_at AS same FROM meetings ORDER BY id`,
    ).toEqual([
      { id: 10, same: true },
      { id: 11, same: true },
    ]);
  });
});
