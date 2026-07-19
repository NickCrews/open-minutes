import { describe, expect } from "vitest";
import { bodiesTable, jurisdictionsTable } from "@open-minutes/core/db";
import { test } from "@open-minutes/core/db/testing/vitest";
import { loadAllTestData } from "../test-utils/test-data";
import { seedDatabase } from "./seed";

// Integration test: each test gets its own freshly-migrated Postgres database
// via the { db } fixture, so tests can't observe each other's writes. The
// value of the seeder is the end-to-end path from test-data/ to live tables,
// which an in-memory fake would not exercise.
describe("seedDatabase", () => {
  // Expected counts derive from the loaded snapshot, never hard-coded, so adding
  // a body to test-data/ does not break this test.
  const snapshot = loadAllTestData();

  test("seeds the jurisdictions and bodies from the snapshot", async ({
    db,
  }) => {
    await seedDatabase(db);

    const jurisdictions = await db.select().from(jurisdictionsTable);
    expect(jurisdictions).toHaveLength(snapshot.jurisdictions.length);
    for (const j of snapshot.jurisdictions) {
      expect(jurisdictions.some((r) => r.name_short === j.name_short)).toBe(
        true,
      );
    }

    const bodies = await db.select().from(bodiesTable);
    expect(bodies).toHaveLength(snapshot.bodies.length);
    for (const b of snapshot.bodies) {
      expect(bodies.some((r) => r.name_short === b.name_short)).toBe(true);
    }
  });

  test("is idempotent: re-running produces the same database", async ({
    db,
  }) => {
    await seedDatabase(db);
    const first = await db.select().from(bodiesTable);

    await seedDatabase(db);
    const second = await db.select().from(bodiesTable);

    expect(second).toHaveLength(first.length);
    expect(second).toHaveLength(snapshot.bodies.length);
  });
});
