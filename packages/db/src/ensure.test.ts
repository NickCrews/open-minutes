import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import postgres from "postgres";
import { jurisdictionsTable } from "./schema";
import { resolveDatabaseUrl } from "./resolve";
import {
  assertSafeName,
  databaseExists,
  ensurePostgresRunning,
  urlForDatabase,
  withAdmin,
} from "./cluster";
import {
  databaseStatus,
  divergenceMessage,
  ensureDatabase,
  type DataState,
  wipeDatabase,
} from "./ensure";
import { localMigrations } from "./migrations";

// Integration tests for the harness against docker-compose's postgres. Each
// test works in databases it names itself (om_test_ prefix) and drops them.

const base = resolveDatabaseUrl("local");
const created: string[] = [];
const quiet = { log: () => {} };

function freshName(): string {
  const name = assertSafeName(`om_test_ens_${randomBytes(5).toString("hex")}`);
  created.push(name);
  return name;
}

async function sqlFor<T>(
  name: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(urlForDatabase(base, name), {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function jurisdictionNames(name: string): Promise<string[]> {
  return sqlFor(name, async (sql) =>
    (
      await sql<{ name_short: string }[]>`
        SELECT name_short FROM jurisdictions ORDER BY name_short`
    ).map((r) => r.name_short),
  );
}

/** A DataState that records how often it ran, inserting one marker row. */
function markerData(fingerprint: string) {
  const state = {
    runs: 0,
    name: "marker",
    fingerprint,
    async apply(db) {
      state.runs++;
      await db.delete(jurisdictionsTable);
      await db
        .insert(jurisdictionsTable)
        .values({ name: `Marker ${fingerprint}`, name_short: fingerprint });
    },
  } satisfies DataState & { runs: number };
  return state;
}

beforeAll(async () => {
  await ensurePostgresRunning(base);
}, 120_000);

afterEach(async () => {
  const names = created.splice(0);
  await withAdmin(base, async (admin) => {
    for (const name of names) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });
});

describe("ensureDatabase", () => {
  test("creates a missing database, migrates it, and is then a no-op", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);

    const first = await ensureDatabase(url, quiet);
    expect(first.created).toBe(true);
    expect(first.applied).toEqual(localMigrations().map((m) => m.name));

    const second = await ensureDatabase(url, quiet);
    expect(second).toMatchObject({
      created: false,
      schemaReset: false,
      applied: [],
      dataApplied: false,
    });

    const status = await databaseStatus(url);
    expect(status.migrations).toEqual({
      pending: [],
      unknown: [],
      modified: [],
    });
  });

  test("clones a new database from cloneFrom, keeping its data", async () => {
    const source = freshName();
    await ensureDatabase(urlForDatabase(base, source), {
      ...quiet,
      data: markerData("main"),
    });

    const branch = freshName();
    const result = await ensureDatabase(urlForDatabase(base, branch), {
      ...quiet,
      cloneFrom: source,
    });
    expect(result.clonedFrom).toBe(source);
    expect(result.applied).toEqual([]);
    expect(await jurisdictionNames(branch)).toEqual(["main"]);
  });

  test("falls back to an empty database when the clone source is busy", async () => {
    const source = freshName();
    await ensureDatabase(urlForDatabase(base, source), quiet);
    const branch = freshName();
    // TEMPLATE requires the source to have no other connections.
    await sqlFor(source, async (sql) => {
      await sql`SELECT 1`; // postgres.js connects lazily
      const result = await ensureDatabase(urlForDatabase(base, branch), {
        ...quiet,
        cloneFrom: source,
      });
      expect(result.created).toBe(true);
      expect(result.clonedFrom).toBeUndefined();
      expect(result.applied.length).toBe(localMigrations().length);
    });
    // Postgres waits ~5s for the source to go idle before giving up.
  }, 30_000);

  test("resets the schema of a local database migrated by another branch", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    const data = markerData("golden");
    await ensureDatabase(url, { ...quiet, data });
    await sqlFor(name, async (sql) => {
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name)
        VALUES ('abc', 0, '29990101000000_from_another_branch')`;
    });

    const result = await ensureDatabase(url, { ...quiet, data });
    expect(result.schemaReset).toBe(true);
    expect(result.applied.length).toBe(localMigrations().length);
    // A reset schema is empty, so the data is seeded again without `dataReset`.
    expect(result.dataApplied).toBe(true);
    expect(data.runs).toBe(2);
    expect((await databaseStatus(url)).migrations?.unknown).toEqual([]);
  });

  test("resets the schema of a local database when an applied migration was edited", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    await ensureDatabase(url, quiet);
    const [first] = localMigrations();
    await sqlFor(name, async (sql) => {
      await sql`
        UPDATE drizzle.__drizzle_migrations SET hash = 'stale'
        WHERE name = ${first!.name}`;
    });
    expect((await databaseStatus(url)).migrations?.modified).toEqual([
      first!.name,
    ]);
    const result = await ensureDatabase(url, quiet);
    expect(result.schemaReset).toBe(true);
  });

  test("schemaReset never: refuses a diverged database and leaves it untouched", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    await ensureDatabase(url, { ...quiet, data: markerData("keep") });
    await sqlFor(name, async (sql) => {
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name)
        VALUES ('abc', 0, '29990101000000_from_another_branch')`;
    });

    await expect(
      ensureDatabase(url, { ...quiet, schemaReset: "never" }),
    ).rejects.toThrow(/29990101000000_from_another_branch/);
    expect(await jurisdictionNames(name)).toEqual(["keep"]);
  });

  test("the refusal on a local database points at up and wipe", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    await ensureDatabase(url, quiet);
    const [first] = localMigrations();
    await sqlFor(name, async (sql) => {
      await sql`
        UPDATE drizzle.__drizzle_migrations SET hash = 'stale'
        WHERE name = ${first!.name}`;
    });
    const error = await ensureDatabase(url, {
      ...quiet,
      schemaReset: "never",
    }).catch((e: Error) => e);
    expect(String(error)).toMatch(/pnpm db up/);
    expect(String(error)).toMatch(/pnpm db wipe/);
  });

  test("schemaReset never: still applies pending migrations", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    await withAdmin(base, (admin) => admin.unsafe(`CREATE DATABASE "${name}"`));
    const result = await ensureDatabase(url, {
      ...quiet,
      schemaReset: "never",
    });
    expect(result.applied.length).toBe(localMigrations().length);
  });

  test("refuses to reset or seed a remote database", async () => {
    const prod = "postgres://u:p@db.example.com/prod";
    await expect(
      ensureDatabase(prod, { ...quiet, schemaReset: "if-needed" }),
    ).rejects.toThrow(/Refusing to reset or seed/);
    await expect(
      ensureDatabase(prod, { ...quiet, data: markerData("x") }),
    ).rejects.toThrow(/Refusing to reset or seed/);
  });

  test("schemaReset always: starts over from empty even when up to date", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    await ensureDatabase(url, { ...quiet, data: markerData("before") });
    await sqlFor(name, async (sql) => {
      await sql`UPDATE jurisdictions SET name_short = 'mine'`;
    });

    const after = markerData("after");
    const result = await ensureDatabase(url, {
      ...quiet,
      schemaReset: "always",
      data: after,
    });
    expect(result.schemaReset).toBe(true);
    expect(result.applied.length).toBe(localMigrations().length);
    expect(result.dataApplied).toBe(true);
    expect(await jurisdictionNames(name)).toEqual(["after"]);
  });

  test("schemaReset always: a new database is only created, not reset", async () => {
    const url = urlForDatabase(base, freshName());
    const result = await ensureDatabase(url, {
      ...quiet,
      schemaReset: "always",
      cloneFrom: null,
    });
    expect(result.created).toBe(true);
    expect(result.schemaReset).toBe(false);
  });

  test("migrates to a pinned schema version, then onward to latest", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    const all = localMigrations();
    const middle = all[5]!.name;

    const pinned = await ensureDatabase(url, {
      ...quiet,
      schemaVersion: middle,
    });
    expect(pinned.applied).toEqual(all.slice(0, 6).map((m) => m.name));
    expect((await databaseStatus(url)).schemaVersion).toBe(middle);

    const rest = await ensureDatabase(url, quiet);
    expect(rest.applied).toEqual(all.slice(6).map((m) => m.name));
    expect((await databaseStatus(url)).schemaVersion).toBe(all.at(-1)!.name);
  });

  test("schemaReset never: refuses to go back to an older version", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    await ensureDatabase(url, quiet);
    await expect(
      ensureDatabase(url, {
        ...quiet,
        schemaReset: "never",
        schemaVersion: localMigrations()[0]!.name,
      }),
    ).rejects.toThrow(/migrations only go forward/);
  });

  test("after wipeDatabase, the next ensure migrates and seeds from scratch", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    await ensureDatabase(url, { ...quiet, data: markerData("before") });

    await wipeDatabase(url, quiet);
    const wiped = await databaseStatus(url);
    expect(wiped.appliedCount).toBe(0);
    expect(wiped.data).toBeNull();

    const after = markerData("after");
    const result = await ensureDatabase(url, { ...quiet, data: after });
    expect(result.applied.length).toBe(localMigrations().length);
    expect(result.dataApplied).toBe(true);
    expect(await jurisdictionNames(name)).toEqual(["after"]);
  });

  test("wipeDatabase refuses a remote database", async () => {
    await expect(
      wipeDatabase("postgres://u:p@db.example.com/prod", quiet),
    ).rejects.toThrow(/ALLOW_REMOTE_WIPE/);
  });

  test("concurrent ensures of one database migrate it exactly once", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureDatabase(url, quiet)),
    );
    const applied = results.flatMap((r) => r.applied);
    expect(applied).toEqual(localMigrations().map((m) => m.name));
    expect(await withAdmin(base, (admin) => databaseExists(admin, name))).toBe(
      true,
    );
  });
});

describe("declared data", () => {
  test("dataReset if-needed: applies once, then again only when the fingerprint changes", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    const v1 = markerData("v1");
    expect(
      (
        await ensureDatabase(url, {
          ...quiet,
          data: v1,
          dataReset: "if-needed",
        })
      ).dataApplied,
    ).toBe(true);
    expect(
      (
        await ensureDatabase(url, {
          ...quiet,
          data: v1,
          dataReset: "if-needed",
        })
      ).dataApplied,
    ).toBe(false);
    expect(v1.runs).toBe(1);

    const v2 = markerData("v2");
    expect(
      (
        await ensureDatabase(url, {
          ...quiet,
          data: v2,
          dataReset: "if-needed",
        })
      ).dataApplied,
    ).toBe(true);
    expect(await jurisdictionNames(name)).toEqual(["v2"]);
    expect((await databaseStatus(url)).data).toMatchObject({
      name: "marker",
      fingerprint: "v2",
    });
  });

  test("dataReset always: reapplies unchanged data over hand edits", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    const data = markerData("v1");
    await ensureDatabase(url, { ...quiet, data });
    await sqlFor(name, async (sql) => {
      await sql`UPDATE jurisdictions SET name_short = 'mine'`;
    });

    const result = await ensureDatabase(url, {
      ...quiet,
      data,
      dataReset: "always",
    });
    expect(result.dataApplied).toBe(true);
    expect(data.runs).toBe(2);
    expect(await jurisdictionNames(name)).toEqual(["v1"]);
  });

  test("dataReset never: seeds a new database, but never overwrites existing data", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    const v1 = markerData("v1");
    expect(
      (await ensureDatabase(url, { ...quiet, data: v1 })).dataApplied,
    ).toBe(true);

    // Your local edits, then the declared data changes upstream.
    await sqlFor(name, async (sql) => {
      await sql`UPDATE jurisdictions SET name_short = 'mine'`;
    });
    const v2 = markerData("v2");
    const logs: string[] = [];
    const result = await ensureDatabase(url, {
      log: (m) => logs.push(m),
      data: v2,
    });
    expect(result.dataApplied).toBe(false);
    expect(v2.runs).toBe(0);
    expect(await jurisdictionNames(name)).toEqual(["mine"]);
    expect(logs.join("\n")).toMatch(/Leaving your data alone/);
  });

  test("dataReset never: seeds an already-migrated database that holds no rows", async () => {
    // e.g. the dev server or `om` CLI migrated it before `pnpm dev` seeded.
    const name = freshName();
    const url = urlForDatabase(base, name);
    await ensureDatabase(url, quiet);
    const data = markerData("x");
    const result = await ensureDatabase(url, {
      ...quiet,
      data,
    });
    expect(result.dataApplied).toBe(true);
    expect(data.runs).toBe(1);
  });

  test("dataReset never: leaves an already-migrated database's untracked data alone", async () => {
    const name = freshName();
    const url = urlForDatabase(base, name);
    await ensureDatabase(url, quiet);
    await sqlFor(name, async (sql) => {
      await sql`INSERT INTO jurisdictions (name, name_short) VALUES ('Mine', 'mine')`;
    });
    const data = markerData("x");
    const result = await ensureDatabase(url, {
      ...quiet,
      data,
    });
    expect(result.dataApplied).toBe(false);
  });
});

describe("divergenceMessage for a remote database", () => {
  const all = [{ name: "20260101000000_a", hash: "a" }];
  const none = { pending: [], unknown: [], modified: [] };

  test("an edited migration: recreate if disposable, else revert", () => {
    const message = divergenceMessage("prod", false, all, all, {
      ...none,
      modified: ["20260101000000_a"],
    });
    expect(message).toMatch(/edited after being applied/);
    expect(message).toMatch(/recreate it from production/);
    expect(message).not.toMatch(/merge it into yours/);
  });

  test("another branch's migrations: merge the base branch", () => {
    const message = divergenceMessage("prod", false, all, all, {
      ...none,
      unknown: ["29990101000000_elsewhere"],
    });
    expect(message).toMatch(/merge it into yours/);
  });
});
