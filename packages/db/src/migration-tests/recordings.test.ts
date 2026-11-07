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
    INSERT INTO jurisdictions (id, slug, name) VALUES (1, 'moa', 'Anchorage');
    INSERT INTO bodies (id, jurisdiction_id, slug, timezone) VALUES
      (1, 1, 'gbos', 'America/Anchorage'),
      (2, 1, 'luc', 'America/Anchorage');
    INSERT INTO meetings (id, site_kind, site_id, title, description, timezone, duration_secs, created_at) VALUES
      (10, 'youtube', 'vid-joint', 'Joint', 'A joint meeting', 'America/Anchorage', '3600', '2026-03-24 01:00:00'),
      (11, 'akleg', 'HRES 2018-09-10 14:00:00', 'House Resources', '', 'America/Anchorage', NULL, '2026-03-25 01:00:00'),
      (12, 'youtube', 'vid-empty', '', '', 'America/Anchorage', NULL, '2026-03-26 01:00:00');
    INSERT INTO meeting_bodies (meeting_id, body_id) VALUES (10, 1), (10, 2), (11, 1), (12, 2);
    INSERT INTO segments (meeting_id, words) VALUES
      (11, '[{"text": "Hi", "start": 5}]'),
      (11, '[{"text": "Bye", "start": 90}]');
    `,
  ),
});

describe(MIGRATION, () => {
  test("gives each meeting a recording, with its bodies, and drops the site columns", async ({
    testDb,
  }) => {
    const sql = testDb.client;
    expect(await testDb.migrateTo(MIGRATION)).toEqual([
      expect.stringMatching(new RegExp(`_${MIGRATION}$`)),
    ]);

    const recordings = await sql`
      SELECT m.id AS meeting_id, r.site, r.external_id, r.permalink, r.title,
        r.description, extract(epoch FROM r.duration_secs)::float AS duration,
        r.published_at, r.found_at::text, r.is_meeting, r.notes,
        r.audio_stored_at, r.audio_error_history
      FROM meetings m JOIN recordings r ON r.id = m.recording_id
      ORDER BY m.id`;
    const common = {
      published_at: null,
      is_meeting: true,
      notes: "",
      audio_stored_at: null,
      audio_error_history: [],
    };
    expect(recordings).toEqual([
      {
        ...common,
        meeting_id: 10,
        site: "youtube",
        external_id: "vid-joint",
        permalink: "https://www.youtube.com/watch?v=vid-joint",
        title: "Joint",
        description: "A joint meeting",
        duration: 3600,
        found_at: "2026-03-24 01:00:00",
      },
      {
        ...common,
        meeting_id: 11,
        site: "akleg",
        external_id: "HRES 2018-09-10 14:00:00",
        permalink:
          "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
        title: "House Resources",
        description: "",
        // The end of its last segment.
        duration: 90.5,
        found_at: "2026-03-25 01:00:00",
      },
      {
        ...common,
        meeting_id: 12,
        site: "youtube",
        external_id: "vid-empty",
        permalink: "https://www.youtube.com/watch?v=vid-empty",
        title: "",
        description: "",
        duration: 0,
        found_at: "2026-03-26 01:00:00",
      },
    ]);

    expect(
      await sql`SELECT m.id AS meeting_id, rb.body_id
        FROM recording_bodies rb JOIN meetings m ON m.recording_id = rb.recording_id
        ORDER BY m.id, rb.body_id`,
    ).toEqual([
      { meeting_id: 10, body_id: 1 },
      { meeting_id: 10, body_id: 2 },
      { meeting_id: 11, body_id: 1 },
      { meeting_id: 12, body_id: 2 },
    ]);

    expect(
      await sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'meetings'
          AND column_name IN ('site_kind', 'site_id', 'url')`,
    ).toEqual([]);
    // A second meeting can't share a recording.
    await expect(
      sql`INSERT INTO meetings (recording_id, timezone)
        SELECT recording_id, timezone FROM meetings WHERE id = 10`,
    ).rejects.toThrow(/meetings_recording_id_key/);
  });
});
