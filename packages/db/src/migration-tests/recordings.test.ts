import { describe, expect } from "vite-plus/test";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// See split-munis-into-jurisdictions-and-bodies.test.ts for how migration
// tests work.

const BEFORE = "slugs";
const MIGRATION = "recordings";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "before-recordings",
    `
    INSERT INTO jurisdictions (id, slug, name) VALUES (1, 'moa', 'Municipality of Anchorage');
    INSERT INTO bodies (id, jurisdiction_id, slug, timezone) VALUES
      (1, 1, 'gbos', 'America/Anchorage'),
      (2, 1, 'luc', 'America/Anchorage'),
      (3, 1, 'hres', 'America/Juneau');
    INSERT INTO meetings (id, site_kind, site_id, title, description, timezone, duration_secs, created_at) VALUES
      (1, 'youtube', '9HoIM5INxpI', 'GBOS Regular', 'www.muni.org/gbos', 'America/Anchorage', '9970', '2026-03-24 01:00:00'),
      (2, 'akleg', 'HRES 2018-09-10 14:00:00', 'House RESOURCES - 2018-09-10 14:00:00', 'Anch LIO AUDITORIUM', 'America/Juneau', NULL, '2026-04-01 00:00:00');
    INSERT INTO meeting_bodies (meeting_id, body_id) VALUES (1, 1), (1, 2), (2, 3);
    `,
  ),
});

describe(MIGRATION, () => {
  test("gives each meeting a recording, then drops site_kind, site_id and url", async ({
    testDb,
  }) => {
    const sql = testDb.client;
    expect(await testDb.migrateTo(MIGRATION)).toEqual([
      expect.stringMatching(new RegExp(`_${MIGRATION}$`)),
    ]);

    expect(
      await sql`SELECT r.site, r.external_id, r.permalink, r.title,
          r.description, r.duration_secs::text, r.found_at::text, r.is_meeting,
          r.scout_id, r.audio_stored_at
        FROM meetings m JOIN recordings r ON r.id = m.recording_id
        ORDER BY m.id`,
    ).toEqual([
      {
        site: "youtube",
        external_id: "9HoIM5INxpI",
        permalink: "https://www.youtube.com/watch?v=9HoIM5INxpI",
        title: "GBOS Regular",
        description: "www.muni.org/gbos",
        duration_secs: "02:46:10",
        found_at: "2026-03-24 01:00:00",
        is_meeting: true,
        scout_id: null,
        audio_stored_at: null,
      },
      {
        site: "akleg",
        external_id: "HRES 2018-09-10 14:00:00",
        permalink:
          "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
        title: "House RESOURCES - 2018-09-10 14:00:00",
        description: "Anch LIO AUDITORIUM",
        duration_secs: null,
        found_at: "2026-04-01 00:00:00",
        is_meeting: true,
        scout_id: null,
        audio_stored_at: null,
      },
    ]);
    expect(
      await sql`SELECT m.id AS meeting_id, rb.body_id
        FROM meetings m JOIN recording_bodies rb ON rb.recording_id = m.recording_id
        ORDER BY m.id, rb.body_id`,
    ).toEqual([
      { meeting_id: 1, body_id: 1 },
      { meeting_id: 1, body_id: 2 },
      { meeting_id: 2, body_id: 3 },
    ]);
    expect(
      await sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'meetings'
          AND column_name IN ('site_kind', 'site_id', 'url')`,
    ).toEqual([]);
  });

  test("allows one meeting per recording, and only known sites", async ({
    testDb,
  }) => {
    const sql = testDb.client;
    await testDb.migrateTo(MIGRATION);
    await expect(
      sql`INSERT INTO meetings (id, recording_id, timezone) VALUES (3, 1, 'America/Anchorage')`,
    ).rejects.toThrow(/meetings_recording_id_key/);
    await expect(
      sql`INSERT INTO recordings (site, external_id) VALUES ('youtube', '9HoIM5INxpI')`,
    ).rejects.toThrow(/recordings_site_external_id_unique/);
    await expect(
      sql`INSERT INTO recordings (site, external_id) VALUES ('vimeo', '1')`,
    ).rejects.toThrow(/recordings_site_known/);
  });

  test("keeps a recording when its meeting is deleted", async ({ testDb }) => {
    const sql = testDb.client;
    await testDb.migrateTo(MIGRATION);
    await sql`DELETE FROM meetings WHERE id = 2`;
    expect(await sql`SELECT external_id FROM recordings ORDER BY id`).toEqual([
      { external_id: "9HoIM5INxpI" },
      { external_id: "HRES 2018-09-10 14:00:00" },
    ]);
  });
});
