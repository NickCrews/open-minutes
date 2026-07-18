import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getDb, type DB } from "../index";
import { resolveDatabaseUrl } from "../resolve.mjs";

// Utilities for tests that need a real Postgres as a disposable playground.
// createTestDb() is fully self-sufficient: it starts docker-compose's postgres
// if nothing is listening, migrates a template, and clones it.
//
// Strategy: migrations are applied once into a template database named after a
// hash of the migration files, then each createTestDb() call clones it with
// `CREATE DATABASE ... TEMPLATE ...` (~tens of ms) instead of re-migrating.
// A schema change produces a new hash, so stale templates are never reused.

const MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const TEMPLATE_PREFIX = "om_test_tmpl_";
const TEST_DB_PREFIX = "om_test_";
// Arbitrary constant identifying "template setup" in pg_advisory_lock, so
// concurrent test processes don't build the same template twice.
const TEMPLATE_LOCK_KEY = 727150421;

export interface TestDb {
  db: DB;
  client: postgres.Sql;
  url: string;
  name: string;
  /** Disconnects and drops the database. Safe to call once. */
  drop(): Promise<void>;
}

// Tests always target "local" unless a URL is passed explicitly: these
// utilities create and drop databases, which must never happen against
// whatever real target $DB happens to select.
function baseUrl(url?: string): string {
  return url ?? resolveDatabaseUrl("local");
}

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Connection to the always-present `postgres` db, for CREATE/DROP DATABASE. */
function adminClient(base: string): postgres.Sql {
  return postgres(urlForDatabase(base, "postgres"), { max: 1 });
}

/** Runs `fn` with an admin connection, always disconnecting afterwards. */
async function withAdmin<T>(
  base: string,
  fn: (admin: postgres.Sql) => Promise<T>,
): Promise<T> {
  const admin = adminClient(base);
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

// All database names we generate match this; quoting is then trivial and
// interpolating into DDL (which cannot be parameterized) is safe.
function assertSafeName(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
  return name;
}

function migrationsHash(): string {
  const hash = createHash("sha256");
  const dirs = readdirSync(MIGRATIONS_FOLDER).sort();
  for (const dir of dirs) {
    const sqlPath = join(MIGRATIONS_FOLDER, dir, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    hash.update(dir);
    hash.update(readFileSync(sqlPath));
  }
  return hash.digest("hex").slice(0, 12);
}

function canConnect(host: string, port: number, timeoutMs = 500) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function findComposeDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "docker-compose.yml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Could not find docker-compose.yml above " + import.meta.url,
      );
    }
    dir = parent;
  }
  return dir;
}

// Memoized per process: after the first call, tests pay nothing to "ensure".
const postgresReady = new Map<string, Promise<void>>();

/**
 * Guarantees a postgres is listening at the given URL (default DATABASE_URL),
 * starting docker-compose's postgres service if the URL is local and down.
 */
export function ensurePostgresRunning(url?: string): Promise<void> {
  const base = baseUrl(url);
  let ready = postgresReady.get(base);
  if (!ready) {
    ready = startPostgresIfDown(base);
    // Only successes stay memoized: a transient failure (say, a docker
    // hiccup) shouldn't poison every later call in the process.
    ready.catch(() => postgresReady.delete(base));
    postgresReady.set(base, ready);
  }
  return ready;
}

async function startPostgresIfDown(base: string): Promise<void> {
  const url = new URL(base);
  const host = url.hostname;
  const port = Number(url.port || 5432);

  if (await canConnect(host, port)) return;

  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(
      `Database at ${host}:${port} is unreachable, and it isn't local so I won't docker-compose it up.`,
    );
  }

  console.log(`No postgres on ${host}:${port} — starting docker compose...`);
  // Capture output and tolerate failure: concurrent test processes can race
  // this command, and the loser's spurious "container name already in use"
  // error doesn't matter as long as the port comes up below.
  const compose = spawnSync(
    "docker",
    ["compose", "up", "-d", "--wait", "postgres"],
    { cwd: findComposeDir(), encoding: "utf8" },
  );

  const deadline = Date.now() + 60_000;
  while (!(await canConnect(host, port))) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for postgres on ${host}:${port}. \`docker compose up\` said:\n${compose.error?.message ?? `${compose.stdout}${compose.stderr}`}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Memoized per process: after the first call, tests pay nothing to "ensure".
const templateReady = new Map<string, Promise<string>>();

/**
 * Guarantees a migrated template database exists, returning its name.
 * Safe to call concurrently from many processes (guarded by a pg advisory
 * lock); cheap to call repeatedly (memoized, and a no-op when it exists).
 */
export function ensureTestTemplate(url?: string): Promise<string> {
  const base = baseUrl(url);
  let ready = templateReady.get(base);
  if (!ready) {
    ready = buildTemplateIfMissing(base);
    // Only successes stay memoized: a transient failure (say, a docker
    // hiccup) shouldn't poison every later call in the process.
    ready.catch(() => templateReady.delete(base));
    templateReady.set(base, ready);
  }
  return ready;
}

async function buildTemplateIfMissing(base: string): Promise<string> {
  await ensurePostgresRunning(base);
  const name = assertSafeName(`${TEMPLATE_PREFIX}${migrationsHash()}`);
  return withAdmin(base, async (admin) => {
    // Session-level lock; released when `admin` disconnects.
    await admin`SELECT pg_advisory_lock(${TEMPLATE_LOCK_KEY})`;
    const [existing] =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (existing) return name;

    // Old-hash templates (and half-built ones from crashed runs) are garbage.
    const stale = await admin`
      SELECT datname FROM pg_database
      WHERE datname LIKE ${TEMPLATE_PREFIX + "%"} AND datname <> ${name}`;
    for (const row of stale) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${assertSafeName(row.datname as string)}" WITH (FORCE)`,
      );
    }

    // Build under a temp name and rename at the end, so a crash mid-migration
    // can never leave a broken database sitting at the template's name.
    const building = assertSafeName(`${name}_building`);
    await admin.unsafe(`CREATE DATABASE "${building}"`);
    const { db, client } = getDb(urlForDatabase(base, building));
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.end();
    }
    await admin.unsafe(`ALTER DATABASE "${building}" RENAME TO "${name}"`);
    return name;
  });
}

/**
 * Creates a fresh, fully-migrated, empty database and returns a connected
 * drizzle handle to it. Callers own the lifecycle: call `drop()` when done.
 */
export async function createTestDb(url?: string): Promise<TestDb> {
  const base = baseUrl(url);
  const template = await ensureTestTemplate(base);
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
    drop: async () => {
      await client.end();
      // FORCE kicks any connections the test leaked besides `client`.
      await withAdmin(base, (admin) =>
        admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}
