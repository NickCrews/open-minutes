import { afterAll, describe, expect, it } from "vitest";
import { getDb, municipalitiesTable } from "@open-minutes/core/db";
import { loadAllTestData } from "../test-utils/test-data";
import { seedDatabase } from "./seed";

// Integration test: runs against a real Postgres via getDb() (DATABASE_URL,
// defaulting to docker-compose's local gbos in test-setup.ts), following the
// connection/lifecycle pattern in core/src/db/smoke.test.ts. The value of the
// seeder is the end-to-end path from test-data/ to live tables, which an
// in-memory fake would not exercise.
describe("seedDatabase", () => {
  const { client, db } = getDb();
  // Expected counts derive from the loaded snapshot, never hard-coded, so adding
  // a municipality to test-data/ does not break this test.
  const snapshot = loadAllTestData();

  afterAll(async () => {
    await client.end();
  });

  it("seeds the municipalities from the snapshot", async () => {
    await seedDatabase(db);

    const rows = await db.select().from(municipalitiesTable);
    expect(rows).toHaveLength(snapshot.municipalities.length);
    for (const m of snapshot.municipalities) {
      expect(rows.some((r) => r.name_short === m.name_short)).toBe(true);
    }
  });

  it("is idempotent: re-running produces the same database", async () => {
    await seedDatabase(db);
    const first = await db.select().from(municipalitiesTable);

    await seedDatabase(db);
    const second = await db.select().from(municipalitiesTable);

    expect(second).toHaveLength(first.length);
    expect(second).toHaveLength(snapshot.municipalities.length);
  });
});
