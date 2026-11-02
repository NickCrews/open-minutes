import { describe, expect } from "vite-plus/test";
import { bodiesTable, jurisdictionsTable } from "@open-minutes/db";
import { dbTest, test } from "@open-minutes/db/testing/vitest";
import { loadBodies, loadJurisdictions } from "@open-minutes/datasets/datums";
import { datasetState } from "./index";

// Integration test: each test gets its own Postgres database cloned from a
// template the harness pre-seeded with the "bodies" dataset. The value of the
// dataset is the end-to-end path from datums/ to live tables, which an
// in-memory fake would not exercise.
const bodies = datasetState("bodies");
const bodiesTest = dbTest({ data: bodies });

// Expected counts derive from the datums, never hard-coded, so adding a
// body to datums/ does not break this test.
const snapshot = { jurisdictions: loadJurisdictions(), bodies: loadBodies() };

describe('the "bodies" dataset', () => {
  bodiesTest(
    "seeds the jurisdictions and bodies from the datums",
    async ({ db }) => {
      const jurisdictions = await db.select().from(jurisdictionsTable);
      expect(jurisdictions).toHaveLength(snapshot.jurisdictions.length);
      for (const j of snapshot.jurisdictions) {
        expect(jurisdictions.some((r) => r.slug === j.slug)).toBe(true);
      }

      const bodies = await db.select().from(bodiesTable);
      expect(bodies).toHaveLength(snapshot.bodies.length);
      for (const b of snapshot.bodies) {
        expect(bodies.some((r) => r.slug === b.slug)).toBe(true);
      }
    },
  );

  bodiesTest(
    "is idempotent: re-applying produces the same database",
    async ({ db }) => {
      // created_at is reset by a reseed; everything else must match.
      const rows = async () =>
        (await db.select().from(bodiesTable).orderBy(bodiesTable.id)).map(
          (row) => ({
            ...row,
            created_at: undefined,
          }),
        );
      const first = await rows();
      await bodies.apply(db);
      expect(await rows()).toEqual(first);
    },
  );

  // The seeder assigns ids explicitly (so URLs are stable across reseeds);
  // the id sequences must still move past them, or the app's first insert of
  // each kind collides with a seeded row.
  bodiesTest("new rows get fresh ids after a seed", async ({ db }) => {
    const [row] = await db
      .insert(jurisdictionsTable)
      .values({ slug: "later", name: "Added Later" })
      .returning({ id: jurisdictionsTable.id });
    expect(row!.id).toBe(snapshot.jurisdictions.length + 1);
  });

  test("has a stable fingerprint", () => {
    expect(bodies.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(bodies.fingerprint).toBe(bodies.fingerprint);
  });
});
