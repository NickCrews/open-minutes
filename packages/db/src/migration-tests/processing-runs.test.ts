import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// Before processing runs, a meeting row existed only once its transcript was
// ingested. The hand-written backfill records that as one succeeded transcript
// run per meeting with segments, at version "untracked", so those meetings
// read as transcribed (by an unknown version) rather than as pending.

const BEFORE = "chapters";
const MIGRATION = "processing-runs";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "ingested-meetings",
    `
    INSERT INTO jurisdictions (id, name, name_short) VALUES (1, 'Somewhere', 'SW');
    INSERT INTO bodies (id, jurisdiction_id, name, name_short, timezone) VALUES
      (1, 1, 'Board', 'B', 'America/Anchorage');
    INSERT INTO meetings (id, body_id, youtube_id, created_at) VALUES
      (1, 1, 'transcribed', '2026-05-01T12:00:00'),
      (2, 1, 'no-segments', '2026-05-02T12:00:00');
    INSERT INTO segments (meeting_id, words) VALUES
      (1, '[{"text": "Hello", "start": 1.0}]'),
      (1, '[{"text": "again", "start": 2.0}]');
    `,
  ),
});

describe(MIGRATION, () => {
  test("records one untracked transcript run per meeting with segments", async ({
    testDb,
  }) => {
    await testDb.migrateTo(MIGRATION);

    const runs = await testDb.client`
      SELECT meeting_id, step, version, status, finished_at::text AS finished_at
      FROM processing_runs ORDER BY id`;
    expect(runs).toEqual([
      {
        meeting_id: 1,
        step: "transcript",
        version: "untracked",
        status: "succeeded",
        finished_at: "2026-05-01 12:00:00",
      },
    ]);

    const latest = await testDb.client`
      SELECT meeting_id, step, version FROM meeting_processing`;
    expect(latest).toEqual([
      { meeting_id: 1, step: "transcript", version: "untracked" },
    ]);
  });

  test("keeps a run's status, finish time and error consistent", async ({
    testDb,
  }) => {
    await testDb.migrateTo(MIGRATION);
    const sql = testDb.client;

    await expect(
      sql`INSERT INTO processing_runs (meeting_id, step, version, status)
          VALUES (2, 'transcript', '1', 'succeeded')`,
    ).rejects.toThrow(/processing_runs_finished_iff_done/);
    await expect(
      sql`INSERT INTO processing_runs (meeting_id, step, version, status, finished_at)
          VALUES (2, 'transcript', '1', 'failed', now())`,
    ).rejects.toThrow(/processing_runs_error_iff_failed/);
    await expect(
      sql`INSERT INTO processing_runs (meeting_id, step, version)
          VALUES (2, 'translation', '1')`,
    ).rejects.toThrow(/processing_runs_step/);
  });
});
