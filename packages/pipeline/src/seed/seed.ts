import { sql } from "drizzle-orm";
import { type DB, municipalitiesTable } from "@open-minutes/core/db";
import { loadAllTestData } from "../test-utils/test-data";
import { mapSnapshot } from "./map";

// Tables the seeder owns, parents before children. `TRUNCATE ... CASCADE`
// already clears dependent rows, but listing the seeded tables explicitly keeps
// the seeder's footprint visible as later slices add meetings, people, and
// segments.
const SEEDED_TABLES = [municipalitiesTable];

/** Per-table count of rows inserted by a seed run. */
export type SeedSummary = Record<string, number>;

function truncateStatement() {
  const tables = sql.join(
    SEEDED_TABLES.map((t) => sql`${t}`),
    sql.raw(", "),
  );
  return sql`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`;
}

/**
 * Wipe every seeded table and restart its identity sequence, so the next insert
 * starts from id 1. Exposed for callers (and tests) that want a clean slate
 * without reseeding.
 */
export async function truncateAll(db: DB): Promise<void> {
  await db.execute(truncateStatement());
}

/**
 * Replace the contents of the seeded tables with the `test-data/` snapshot, in a
 * single transaction: truncate, then insert. Idempotent — running it twice
 * leaves the database in the same state — and atomic — a failure mid-seed rolls
 * back, leaving the database unchanged. Returns a per-table count summary.
 */
export async function seedDatabase(db: DB): Promise<SeedSummary> {
  const mapped = mapSnapshot(loadAllTestData());
  return await db.transaction(async (tx) => {
    await tx.execute(truncateStatement());
    await tx.insert(municipalitiesTable).values(mapped.municipalities);
    return { municipalities: mapped.municipalities.length };
  });
}
