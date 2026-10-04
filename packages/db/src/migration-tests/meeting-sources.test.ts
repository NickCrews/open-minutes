import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// See split-munis-into-jurisdictions-and-bodies.test.ts for how migration
// tests work.

const BEFORE = "meeting-slug";
const MIGRATION = "meeting-sources";

// Shaped like production's: GBOS on its channel, the Assembly on the MOA
// channel, P&Z with no source.
const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "before-meeting-sources",
    `
    INSERT INTO jurisdictions (id, name, name_short) VALUES (1, 'Municipality of Anchorage', 'MOA');
    INSERT INTO bodies (id, jurisdiction_id, name_short, timezone) VALUES
      (1, 1, 'GBOS', 'America/Anchorage'),
      (2, 1, 'Assembly', 'America/Anchorage'),
      (3, 1, 'Anc P&Z', 'America/Anchorage');
    INSERT INTO video_sources (body_id, kind, youtube_id) VALUES
      (1, 'channel', 'UCgbos'),
      (2, 'playlist', 'PLassembly');
    INSERT INTO meetings (body_id, youtube_id, title) VALUES
      (1, 'vid-gbos', 'GBOS regular meeting'),
      (3, 'vid-pzc', 'P&Z regular meeting');
    `,
  ),
});

describe(MIGRATION, () => {
  test("moves each body's video source onto it, and meetings onto sites", async ({
    testDb,
  }) => {
    const sql = testDb.client;
    expect(await testDb.migrateTo(MIGRATION)).toEqual([
      expect.stringMatching(new RegExp(`_${MIGRATION}$`)),
    ]);

    expect(
      await sql`SELECT name_short, meeting_source FROM bodies ORDER BY id`,
    ).toEqual([
      {
        name_short: "GBOS",
        meeting_source: { type: "youtube_channel", channel_id: "UCgbos" },
      },
      {
        name_short: "Assembly",
        meeting_source: { type: "youtube_playlist", playlist_id: "PLassembly" },
      },
      { name_short: "Anc P&Z", meeting_source: null },
    ]);

    expect(
      await sql`SELECT site_kind, site_id, url FROM meetings ORDER BY id`,
    ).toEqual([
      {
        site_kind: "youtube",
        site_id: "vid-gbos",
        url: "https://www.youtube.com/watch?v=vid-gbos",
      },
      {
        site_kind: "youtube",
        site_id: "vid-pzc",
        url: "https://www.youtube.com/watch?v=vid-pzc",
      },
    ]);

    // What they replace is gone.
    expect(
      await sql`SELECT table_name FROM information_schema.tables
        WHERE table_name = 'video_sources'`,
    ).toEqual([]);
    const columns = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'meetings' AND column_name LIKE 'youtube%'`;
    expect(columns).toEqual([]);
  });

  test("gives akleg.gov meetings their page as url, and checks sources", async ({
    testDb,
  }) => {
    const sql = testDb.client;
    await testDb.migrateTo(MIGRATION);

    const rows = await sql`
      INSERT INTO meetings (body_id, site_kind, site_id) VALUES
        (2, 'akleg', 'SL&C 2026-02-03 13:30:00'),
        (2, 'akleg', 'HRES 2018-09-10 14:00:00')
      RETURNING url`;
    expect(rows).toEqual([
      {
        url: "https://www.akleg.gov/basis/Meeting/Detail?Meeting=SL%26C%202026-02-03%2013:30:00",
      },
      {
        url: "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
      },
    ]);

    await sql`UPDATE bodies SET meeting_source = '{"type":"akleg_committee","committee":"HRES"}' WHERE id = 3`;
    await expect(
      sql`UPDATE bodies SET meeting_source = '{"type":"akleg_committee"}' WHERE id = 3`,
    ).rejects.toThrow(/bodies_meeting_source_valid/);
    await expect(
      sql`UPDATE bodies SET meeting_source = '{"type":"vimeo","id":"1"}' WHERE id = 3`,
    ).rejects.toThrow(/bodies_meeting_source_valid/);
    await expect(
      sql`INSERT INTO meetings (body_id, site_kind, site_id) VALUES (1, 'akleg', 'HRES 2018-09-10 14:00:00')`,
    ).rejects.toThrow(/meetings_site_kind_site_id_unique/);
  });
});

const severalSources = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "before-meeting-sources-several",
    `
    INSERT INTO jurisdictions (id, name, name_short) VALUES (1, 'Municipality of Anchorage', 'MOA');
    INSERT INTO bodies (id, jurisdiction_id, name_short, timezone) VALUES
      (1, 1, 'Assembly', 'America/Anchorage');
    INSERT INTO video_sources (body_id, kind, youtube_id) VALUES
      (1, 'channel', 'UCmoa'),
      (1, 'playlist', 'PLassembly');
    `,
  ),
});

describe(`${MIGRATION}, with a body with several video sources`, () => {
  severalSources("refuses to pick one", async ({ testDb }) => {
    await expect(testDb.migrateTo(MIGRATION)).rejects.toThrow(
      /several video sources/,
    );
  });
});
