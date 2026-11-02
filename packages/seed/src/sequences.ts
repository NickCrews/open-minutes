import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { DB } from "@open-minutes/db";

/**
 * Seeders insert rows with explicit ids (so ids, and the URLs built on them,
 * are stable across reseeds), which leaves each serial `id` sequence behind.
 * Move every sequence to just past its table's highest id, so the app's own
 * inserts after a seed don't collide with seeded rows.
 */
export async function advanceIdSequences(
  db: Pick<DB, "execute">,
  tables: readonly PgTable[],
): Promise<void> {
  for (const table of tables) {
    const name = getTableName(table);
    await db.execute(sql`
      SELECT setval(
        pg_get_serial_sequence(${name}, 'id'),
        COALESCE((SELECT max(id) FROM ${table}), 0) + 1,
        false
      )`);
  }
}
