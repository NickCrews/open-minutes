import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// start_secs/end_secs/duration_secs stop being stored values and become
// generated from `words`, so they can't drift from the word timings. Empty
// segments (no words, no position on the timeline) are deleted and banned.

const BEFORE = "body-timezone-and-instant-start-time";
const MIGRATION = "derive-segment-times-from-words";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "segments-with-stale-times",
    `
    INSERT INTO jurisdictions (id, name) VALUES (1, 'MOA');
    INSERT INTO bodies (id, jurisdiction_id, name, timezone) VALUES (1, 1, 'GBOS', 'America/Anchorage');
    INSERT INTO meetings (id, body_id, youtube_id) VALUES (1, 1, 'v1');
    -- Stored times disagree with the words: the migration must trust words.
    INSERT INTO segments (id, meeting_id, start_secs, end_secs, words) VALUES
      (1, 1, '99 seconds', '99 seconds',
        '[{"text": "Call", "start": 1.5, "end": 1.8}, {"text": "to order.", "start": 2.0, "end": 2.75}]'),
      (2, 1, NULL, NULL, '[]');
    `,
  ),
});

describe(MIGRATION, () => {
  test("derives times from words and drops wordless segments", async ({
    testDb,
  }) => {
    await testDb.migrateTo(MIGRATION);
    const rows = await testDb.client`
      SELECT id, text,
        extract(epoch FROM start_secs)::float8 AS start,
        extract(epoch FROM end_secs)::float8 AS end,
        extract(epoch FROM duration_secs)::float8 AS duration
      FROM segments ORDER BY id`;
    expect(rows).toEqual([
      { id: 1, text: "Call to order.", start: 1.5, end: 2.75, duration: 1.25 },
    ]);
  });

  test("rejects new wordless segments", async ({ testDb }) => {
    await testDb.migrateTo(MIGRATION);
    await expect(
      testDb.client`INSERT INTO segments (meeting_id, words) VALUES (1, '[]')`,
    ).rejects.toThrow(/segments_words_nonempty/);
  });
});
