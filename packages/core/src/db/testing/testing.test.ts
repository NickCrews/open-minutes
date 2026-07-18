import { describe, expect } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../index";
import { municipalitiesTable } from "../schema";
import { createTestDb } from "./index";
import { test } from "./vitest";

describe("createTestDb", () => {
  test("provides a migrated, empty database", async ({ db }) => {
    const rows = await db.select().from(municipalitiesTable);
    expect(rows).toHaveLength(0);
  });

  // Both isolation tests insert the same row; if they shared a database (like
  // the old one-db-per-run setup), whichever runs second would see 2 rows.
  test("isolates writes from other tests (a)", async ({ db }) => {
    await db
      .insert(municipalitiesTable)
      .values({ name: "Isolation Check", name_short: "isolation-check" });
    const rows = await db.select().from(municipalitiesTable);
    expect(rows).toHaveLength(1);
  });

  test("isolates writes from other tests (b)", async ({ db }) => {
    await db
      .insert(municipalitiesTable)
      .values({ name: "Isolation Check", name_short: "isolation-check" });
    const rows = await db.select().from(municipalitiesTable);
    expect(rows).toHaveLength(1);
  });

  test("drop() removes the database", async () => {
    const handle = await createTestDb();
    const [result] = await handle.db.execute(sql`SELECT 1 AS value`);
    expect(result!.value).toBe(1);

    await handle.drop();

    const adminUrl = new URL(handle.url);
    adminUrl.pathname = "/postgres";
    const { db: admin, client } = getDb(adminUrl.toString());
    const rows = await admin.execute(
      sql`SELECT 1 FROM pg_database WHERE datname = ${handle.name}`,
    );
    expect(rows).toHaveLength(0);
    await client.end();
  });
});
