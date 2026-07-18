import { describe, expect } from "vitest";
import { municipalitiesTable } from "@open-minutes/core/db";
import { test } from "@open-minutes/core/db/testing/vitest";
import { loadAllTestData } from "../test-utils/test-data";
import { seedDatabase } from "./seed";

// Integration test: each test gets its own freshly-migrated Postgres database
// via the { db } fixture, so tests can't observe each other's writes. The
// value of the seeder is the end-to-end path from test-data/ to live tables,
// which an in-memory fake would not exercise.
describe("seedDatabase", () => {
  // Expected counts derive from the loaded snapshot, never hard-coded, so adding
  // a municipality to test-data/ does not break this test.
  const snapshot = loadAllTestData();

  test("seeds the municipalities from the snapshot", async ({ db }) => {
    await seedDatabase(db);

    const rows = await db.select().from(municipalitiesTable);
    expect(rows).toHaveLength(snapshot.municipalities.length);
    for (const m of snapshot.municipalities) {
      expect(rows.some((r) => r.name_short === m.name_short)).toBe(true);
    }
  });

  test("is idempotent: re-running produces the same database", async ({
    db,
  }) => {
    await seedDatabase(db);
    const first = await db.select().from(municipalitiesTable);

    await seedDatabase(db);
    const second = await db.select().from(municipalitiesTable);

    expect(second).toHaveLength(first.length);
    expect(second).toHaveLength(snapshot.municipalities.length);
  });
});
