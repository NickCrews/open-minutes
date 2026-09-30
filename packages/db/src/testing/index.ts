import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { getDb, type DB } from "../index";
import { resolveDatabaseUrl } from "../resolve";
import {
  assertSafeName,
  ensurePostgresRunning,
  urlForDatabase,
  withAdmin,
} from "../cluster";
import { sql } from "drizzle-orm";
import { ensureDatabase, type DataState } from "../ensure";
import {
  localMigrations,
  migrationsFingerprint,
  migrationsUpTo,
  type SchemaVersion,
} from "../migrations";

// Utilities for tests that need a real Postgres as a disposable playground.
// createTestDb() is fully self-sufficient: it starts docker-compose's postgres
// if nothing is listening, builds a template, and clones it.
//
// The declared state is built once by ensureDatabase() into a template named
// after its fingerprint; each createTestDb() clones it (~tens of ms). Changing a
// migration or the data changes the fingerprint, so stale templates aren't reused.

/** Every test database and template name starts with this. */
export const TEST_DB_PREFIX = "om_test_";
/** Every test template name starts with this. */
export const TEMPLATE_PREFIX = `${TEST_DB_PREFIX}tmpl_`;
// Arbitrary constant identifying "template setup" in pg_advisory_lock, so
// concurrent test processes don't build the same template twice.
const TEMPLATE_LOCK_KEY = 727150421;

export interface TestDbOptions {
  /** Server to create the database on. Defaults to the "local" target. */
  url?: string;
  /**
   * The schema to start at. Defaults to "latest". Pin an older version to test
   * a migration: start just before it, seed, then `migrateTo` it.
   */
  schemaVersion?: SchemaVersion;
  /**
   * Rows the database should start with. Defaults to none (empty tables).
   * Seeders written with drizzle's table objects target the *latest* schema;
   * for older versions use {@link sqlData}.
   */
  data?: DataState;
}

export interface TestDb {
  db: DB;
  client: postgres.Sql;
  url: string;
  name: string;
  /**
   * Applies migrations up to and including `version` (default "latest"), the
   * way deploys do, and returns the names applied. Throws if the database is
   * already past `version`: migrations only go forward.
   */
  migrateTo(version?: SchemaVersion): Promise<string[]>;
  /** Disconnects and drops the database. Safe to call once. */
  drop(): Promise<void>;
}

/**
 * A DataState from raw SQL, for seeding schemas older than the current
 * drizzle table definitions (e.g. the "before" side of a migration test).
 * The fingerprint is the SQL itself, so editing it rebuilds the template.
 */
export function sqlData(name: string, statements: string): DataState {
  return {
    name,
    fingerprint: createHash("sha256")
      .update(statements)
      .digest("hex")
      .slice(0, 12),
    apply: async (db) => {
      await db.execute(sql.raw(statements));
    },
  };
}

// Tests always target "local" unless a URL is passed explicitly: these
// utilities create and drop databases, which must never happen against
// whatever real target $DB happens to select.
function baseUrl(url?: string): string {
  return url ?? resolveDatabaseUrl("local");
}

/**
 * The template's name: the schema version, plus the data's identity if any:
 * `${TEMPLATE_PREFIX}${schema}[_${data}]`, schema and data 12 hex chars each.
 */
export function templateName(
  schemaVersion: SchemaVersion,
  data: DataState | undefined,
): string {
  const schema = migrationsFingerprint(migrationsUpTo(schemaVersion));
  if (!data) return assertSafeName(`${TEMPLATE_PREFIX}${schema}`);
  const dataKey = createHash("sha256")
    .update(`${data.name}\0${data.fingerprint}`)
    .digest("hex")
    .slice(0, 12);
  return assertSafeName(`${TEMPLATE_PREFIX}${schema}_${dataKey}`);
}

// Memoized per process: after the first call, tests pay nothing to "ensure".
const templateReady = new Map<string, Promise<string>>();

/**
 * Guarantees a template database in the declared state exists, returning its
 * name. Safe to call concurrently from many processes (guarded by a pg
 * advisory lock); cheap to call repeatedly (memoized, and a no-op when it
 * exists).
 */
export function ensureTestTemplate(
  options: TestDbOptions = {},
): Promise<string> {
  const base = baseUrl(options.url);
  const name = templateName(options.schemaVersion ?? "latest", options.data);
  const key = `${base} ${name}`;
  let ready = templateReady.get(key);
  if (!ready) {
    ready = buildTemplateIfMissing(base, name, options);
    // Only successes stay memoized: a transient failure (say, a docker
    // hiccup) shouldn't poison every later call in the process.
    ready.catch(() => templateReady.delete(key));
    templateReady.set(key, ready);
  }
  return ready;
}

async function buildTemplateIfMissing(
  base: string,
  name: string,
  options: TestDbOptions,
): Promise<string> {
  await ensurePostgresRunning(base);
  return withAdmin(base, async (admin) => {
    // Session-level lock; released when `admin` disconnects.
    await admin`SELECT pg_advisory_lock(${TEMPLATE_LOCK_KEY})`;
    const [existing] =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (existing) return name;

    // Templates for a schema that is no longer a version of this checkout's
    // history (a migration was edited, or another branch's), and half-built
    // ones from crashed runs, are garbage. Templates for any current version,
    // with any data, are kept: one run may use several.
    const live = liveSchemaFingerprints();
    const templates = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE ${TEMPLATE_PREFIX + "%"}`;
    const stale = templates.filter(
      ({ datname }) =>
        datname.endsWith("_building") ||
        !live.has(datname.slice(TEMPLATE_PREFIX.length).slice(0, 12)),
    );
    for (const row of stale) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${assertSafeName(row.datname as string)}" WITH (FORCE)`,
      );
    }

    // Build under a temp name and rename at the end, so a crash mid-build can
    // never leave a broken database sitting at the template's name.
    const building = assertSafeName(`${name}_building`);
    await admin.unsafe(`CREATE DATABASE "${building}"`);
    await ensureDatabase(urlForDatabase(base, building), {
      schemaVersion: options.schemaVersion,
      data: options.data,
      log: () => {},
    });
    await admin.unsafe(`ALTER DATABASE "${building}" RENAME TO "${name}"`);
    return name;
  });
}

/**
 * Creates a fresh database in the declared state (migrated; empty unless
 * `data` is given) and returns a connected drizzle handle to it. Callers own
 * the lifecycle: call `drop()` when done.
 */
export async function createTestDb(
  options: TestDbOptions = {},
): Promise<TestDb> {
  const base = baseUrl(options.url);
  const template = await ensureTestTemplate(options);
  const name = assertSafeName(
    `${TEST_DB_PREFIX}${randomBytes(6).toString("hex")}`,
  );

  await withAdmin(base, (admin) =>
    admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`),
  );

  const dbUrl = urlForDatabase(base, name);
  const { db, client } = getDb(dbUrl);
  return {
    db,
    client,
    url: dbUrl,
    name,
    migrateTo: async (version = "latest") => {
      const result = await ensureDatabase(dbUrl, {
        // The way deploys migrate: apply forward, never reset.
        schemaReset: "never",
        schemaVersion: version,
        log: () => {},
      });
      return result.applied;
    },
    drop: async () => {
      await client.end();
      // FORCE kicks any connections the test leaked besides `client`.
      await withAdmin(base, (admin) =>
        admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}

/** Fingerprints of the schema at every version of this checkout's history. */
function liveSchemaFingerprints(): Set<string> {
  const all = localMigrations();
  return new Set(all.map((_, i) => migrationsFingerprint(all.slice(0, i + 1))));
}

export { ensurePostgresRunning } from "../cluster";
export type { DataState } from "../ensure";
