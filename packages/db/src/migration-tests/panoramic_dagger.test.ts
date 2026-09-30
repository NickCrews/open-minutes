import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// People's names become nullable, and the two old spellings of "we don't know
// who this is" ('' and the literal 'Unknown Speaker') collapse onto NULL, so
// the UI stops showing unidentified voices as identified.

const BEFORE = "derive-segment-text-from-words";
const MIGRATION = "panoramic_dagger";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "unknown-speaker-names",
    `
    INSERT INTO people (name, voice_embedding) VALUES
      ('', array_fill(0, ARRAY[192])::vector),
      ('Unknown Speaker', array_fill(0, ARRAY[192])::vector),
      ('Mike Edgington', array_fill(0, ARRAY[192])::vector);
    `,
  ),
});

describe(MIGRATION, () => {
  test("turns placeholder names into NULL and keeps real ones", async ({
    testDb,
  }) => {
    await testDb.migrateTo(MIGRATION);
    const rows = await testDb.client`SELECT id, name FROM people ORDER BY id`;
    expect(rows).toEqual([
      { id: 1, name: null },
      { id: 2, name: null },
      { id: 3, name: "Mike Edgington" },
    ]);
  });

  test("new people can be inserted without a name", async ({ testDb }) => {
    await testDb.migrateTo(MIGRATION);
    const [row] = await testDb.client`
      INSERT INTO people (voice_embedding) VALUES (array_fill(0, ARRAY[192])::vector)
      RETURNING name`;
    expect(row!.name).toBeNull();
  });
});
