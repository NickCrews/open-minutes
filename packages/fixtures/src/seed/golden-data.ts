import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  jurisdictionsTable,
  videoSourcesTable,
} from "@open-minutes/db";
import type { DataState } from "@open-minutes/db/ensure";
import { loadAllTestData } from "../test-data";
import { mapSnapshot } from "./map";
import { advanceIdSequences } from "./sequences";

// The `test-data/` snapshot as a declarative data state: the harness
// (`ensureDatabase`, test templates) records this fingerprint when it seeds,
// and knows the data is stale when the fingerprint changes. Seed through the
// harness (`pnpm db up --data golden --data-reset if-needed`), never by calling `apply` out of band, or
// the recorded fingerprint no longer describes the database.

// Bump when seedGolden's behavior changes in a way the rows below don't
// capture (e.g. it starts seeding another table from the same snapshot).
const SEED_VERSION = 2; // 2: advances id sequences past the seeded rows

// Tables the golden seeder owns, parents before children. `TRUNCATE ...
// CASCADE` already clears dependent rows, but listing the seeded tables
// explicitly keeps the seeder's footprint visible.
const SEEDED_TABLES = [jurisdictionsTable, bodiesTable, videoSourcesTable];

/**
 * Replace the contents of the seeded tables with the `test-data/` snapshot, in
 * a single transaction: truncate, then insert. Idempotent and atomic — a
 * failure mid-seed rolls back, leaving the database unchanged.
 */
async function seedGolden(db: DB): Promise<void> {
  const mapped = mapSnapshot(loadAllTestData());
  await db.transaction(async (tx) => {
    const tables = sql.join(
      SEEDED_TABLES.map((t) => sql`${t}`),
      sql.raw(", "),
    );
    await tx.execute(sql`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    await tx.insert(jurisdictionsTable).values(mapped.jurisdictions);
    await tx.insert(bodiesTable).values(mapped.bodies);
    await tx.insert(videoSourcesTable).values(mapped.videoSources);
    await advanceIdSequences(tx, SEEDED_TABLES);
  });
}

let fingerprint: string | undefined;

function computeFingerprint(): string {
  const { jurisdictions, bodies, videoSources } =
    mapSnapshot(loadAllTestData());
  return createHash("sha256")
    .update(
      JSON.stringify({ SEED_VERSION, jurisdictions, bodies, videoSources }),
    )
    .digest("hex")
    .slice(0, 12);
}

/** The jurisdictions, bodies, and video sources from `test-data/`. */
export const goldenData: DataState = {
  name: "golden",
  get fingerprint() {
    fingerprint ??= computeFingerprint();
    return fingerprint;
  },
  apply: seedGolden,
};
