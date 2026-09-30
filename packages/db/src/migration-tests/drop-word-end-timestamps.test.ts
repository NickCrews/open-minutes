import { describe, expect } from "vitest";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { sqlData } from "../testing";
import { dbTest, test as latestTest } from "../testing/vitest";

// Words stop storing an `end` (the recognizer only reports onsets; `end` was
// an estimate). The migration rewrites every stored word array and redefines
// a segment's end as its last onset plus a nominal last-word duration.

const BEFORE = "add-person-bio";
const MIGRATION = "drop-word-end-timestamps";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "words-with-ends",
    `
    INSERT INTO jurisdictions (id, name) VALUES (1, 'MOA');
    INSERT INTO bodies (id, jurisdiction_id, name, timezone) VALUES (1, 1, 'GBOS', 'America/Anchorage');
    INSERT INTO meetings (id, body_id, youtube_id) VALUES (1, 1, 'v1');
    INSERT INTO segments (id, meeting_id, words) VALUES
      (1, 1, '[{"text": "Motion", "start": 10.0, "end": 10.4},
               {"text": "carries.", "start": 10.5, "end": 11.2}]');
    `,
  ),
});

describe(MIGRATION, () => {
  test("strips `end` from every word, keeping order and text", async ({
    testDb,
  }) => {
    await testDb.migrateTo(MIGRATION);
    const [row] = await testDb.client`
      SELECT words, text,
        extract(epoch FROM start_secs)::float8 AS start,
        extract(epoch FROM end_secs)::float8 AS end
      FROM segments WHERE id = 1`;
    expect(row).toEqual({
      words: [
        { text: "Motion", start: 10.0 },
        { text: "carries.", start: 10.5 },
      ],
      text: "Motion carries.",
      start: 10.0,
      // Last onset + the nominal last-word duration, not the old `end`.
      end: 10.5 + LAST_WORD_DURATION_SEC,
    });
  });
});

// The migration hard-codes the last-word duration in SQL, with a comment to
// keep it in sync with LAST_WORD_DURATION_SEC. This holds it to that, at the
// latest schema (a later migration could redefine the function).
latestTest(
  "words_end_secs agrees with LAST_WORD_DURATION_SEC",
  async ({ testDb }) => {
    const [row] = await testDb.client`
      SELECT extract(epoch FROM words_end_secs('[{"text": "a", "start": 3}]'::jsonb))::float8 AS end`;
    expect(row!.end).toBe(3 + LAST_WORD_DURATION_SEC);
  },
);
