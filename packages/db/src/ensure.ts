import process from "node:process";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { DB } from "./index";
import { relations } from "./schema";
import { LOCAL_DATABASE_PREFIX, LOCAL_MAIN_DATABASE } from "./resolve";
import {
  assertSafeName,
  databaseExists,
  databaseName,
  directUrl,
  ensurePostgresRunning,
  isLocalUrl,
  urlForDatabase,
  withAdmin,
} from "./cluster";
import {
  compareMigrations,
  describeStatus,
  isDiverged,
  JOURNAL_SCHEMA,
  JOURNAL_TABLE,
  type MigrationRef,
  type MigrationStatus,
} from "./migration-status";
import {
  appliedMigrations,
  localMigrations,
  migrationsUpTo,
  withMigrationsFolder,
  type SchemaVersion,
} from "./migrations";

// The declarative database harness: "make the database at this URL be in this
// state", where state = a schema version plus optional declared data. `pnpm
// dev`, `pnpm db`, CI, deploys and test templates all go through here.
//
// Creating a local database and applying pending migrations are always
// allowed. Resetting the schema or data is governed by a ResetPolicy (see
// EnsureOptions), and never happens to a non-local database unless
// ALLOW_REMOTE_WIPE=1.

/**
 * A named, versioned set of rows the database should contain. The harness
 * records the fingerprint it last applied, so `apply` runs only when the
 * declaration changes (or the database is new).
 */
export interface DataState {
  /** Human-readable name, e.g. "golden". */
  name: string;
  /** Changes whenever `apply` would produce different rows. */
  fingerprint: string;
  /** Idempotently makes the rows exist. May be destructive: dev-only. */
  apply(db: DB): Promise<void>;
}

/** When the harness may reset the schema or the data. See EnsureOptions. */
export type ResetPolicy = "never" | "if-needed" | "always";

export const RESET_POLICIES: readonly ResetPolicy[] = [
  "never",
  "if-needed",
  "always",
];

export interface EnsureOptions {
  /** Default "latest". An older version is useful for testing a migration. */
  schemaVersion?: SchemaVersion;
  data?: DataState;
  /**
   * When to wipe the schema (tables, data, migration history) and re-apply
   * every migration:
   *
   * - `"never"`: a migration history that disagrees with this checkout's is
   *   an error, and nothing is touched.
   * - `"if-needed"`: only when that history disagrees (another branch's
   *   migrations, an edited migration, or a database past the target).
   * - `"always"`: every time, starting from empty.
   *
   * Default: `"if-needed"` for local databases, `"never"` otherwise.
   */
  schemaReset?: ResetPolicy;
  /**
   * When to apply `data` over data already in the database:
   *
   * - `"never"`: seed only a database that holds no data.
   * - `"if-needed"`: also whenever the database holds anything but `data`.
   * - `"always"`: every time, e.g. to undo hand edits.
   *
   * Default: `"never"`.
   */
  dataReset?: ResetPolicy;
  /**
   * A local database to clone a new one from, falling back to empty if the
   * clone fails. Defaults to {@link defaultCloneSource}; `null` starts empty.
   */
  cloneFrom?: string | null;
  /** Progress output. Defaults to stderr. */
  log?: (message: string) => void;
}

export interface EnsureResult {
  /** The database didn't exist and was created (maybe as a clone). */
  created: boolean;
  /** Set when `created` came from cloning `cloneFrom`. */
  clonedFrom?: string;
  /** The schema was wiped and every migration re-applied. */
  schemaReset: boolean;
  /** Migrations applied by this call, in order. */
  applied: string[];
  /** The declared data was (re)applied by this call. */
  dataApplied: boolean;
}

/** Where the harness records which DataState a database holds. */
const DATA_STATE_TABLE = "__om_data_state";

// Arbitrary pg_advisory_lock key. Advisory locks are per-database, so this
// serializes concurrent ensures of one database without blocking others.
const ENSURE_LOCK_KEY = 727150422;

/** Whether a non-local database may be wiped, rebuilt, or seeded. */
function remoteWipeAllowed(): boolean {
  return process.env.ALLOW_REMOTE_WIPE === "1";
}

/** A new local per-branch database starts as a copy of main's. */
export function defaultCloneSource(url: string): string | undefined {
  if (!isLocalUrl(url)) return undefined;
  return databaseName(url).startsWith(LOCAL_DATABASE_PREFIX)
    ? LOCAL_MAIN_DATABASE
    : undefined;
}

export async function ensureDatabase(
  url: string,
  options: EnsureOptions = {},
): Promise<EnsureResult> {
  url = directUrl(url);
  const log = options.log ?? ((m: string) => console.error(m));
  const local = isLocalUrl(url);
  const schemaReset = options.schemaReset ?? (local ? "if-needed" : "never");
  const dataReset = options.dataReset ?? "never";
  const label = databaseLabel(url);

  if (
    !local &&
    (schemaReset !== "never" || options.data) &&
    !remoteWipeAllowed()
  ) {
    throw new Error(
      `Refusing to reset or seed non-local ${label}. \`pnpm db migrate\` ` +
        `applies migrations without touching data; set ALLOW_REMOTE_WIPE=1 ` +
        `if this database is disposable.`,
    );
  }

  const result: EnsureResult = {
    created: false,
    schemaReset: false,
    applied: [],
    dataApplied: false,
  };

  if (local) {
    await ensurePostgresRunning(url);
    const cloneFrom =
      options.cloneFrom === undefined
        ? defaultCloneSource(url)
        : (options.cloneFrom ?? undefined);
    const created = await createDatabaseIfMissing(url, cloneFrom, log);
    result.created = created !== false;
    if (typeof created === "string") result.clonedFrom = created;
  }

  await withEnsureLock(url, async (lock) => {
    const all = localMigrations();
    const target = migrationsUpTo(options.schemaVersion ?? "latest", all);
    let applied = await appliedMigrations(lock);
    let status = compareMigrations(target, applied ?? []);

    const diverged = isDiverged(status);
    if (diverged && schemaReset === "never") {
      throw new Error(divergenceMessage(label, local, target, all, status));
    }
    if (diverged || (schemaReset === "always" && applied !== null)) {
      log(
        diverged
          ? `${label}'s migration history diverged from this checkout; resetting its schema.\n${describeStatus(status)}`
          : `Resetting ${label}'s schema (--schema-reset always).`,
      );
      await wipeSchema(lock);
      result.schemaReset = true;
      applied = null;
      status = compareMigrations(target, []);
    }

    const startedEmpty = applied === null || applied.length === 0;

    if (status.pending.length > 0) {
      log(`Applying ${status.pending.length} migration(s) to ${label}...`);
      await runMigrations(url, target);
      result.applied = status.pending;
      for (const name of status.pending) log(`  ✓ ${name}`);
    }

    if (options.data) {
      result.dataApplied = await ensureData(
        lock,
        url,
        options.data,
        dataReset,
        startedEmpty,
        label,
        log,
      );
    }
  });

  if (!result.applied.length && !result.dataApplied && !result.schemaReset) {
    log(`${label} is up to date.`);
  }
  return result;
}

/**
 * Drops every table, the migration journal and the data record, leaving what a
 * new database has. Does nothing if a local database doesn't exist.
 */
export async function wipeDatabase(
  url: string,
  options: { log?: (message: string) => void } = {},
): Promise<void> {
  url = directUrl(url);
  const log = options.log ?? ((m: string) => console.error(m));
  const label = databaseLabel(url);
  if (isLocalUrl(url)) {
    await ensurePostgresRunning(url);
    const exists = await withAdmin(url, (admin) =>
      databaseExists(admin, databaseName(url)),
    );
    if (!exists) {
      log(`${label} doesn't exist; nothing to wipe.`);
      return;
    }
  } else if (!remoteWipeAllowed()) {
    throw new Error(
      `Refusing to wipe non-local ${label}; set ALLOW_REMOTE_WIPE=1 if this database is disposable.`,
    );
  }
  await withEnsureLock(url, wipeSchema);
  log(`Wiped ${label}.`);
}

function databaseLabel(url: string): string {
  return `${new URL(url).hostname}/${databaseName(url)}`;
}

/**
 * Runs `fn` holding the per-database advisory lock, on a dedicated connection
 * that holds it throughout. Session-level advisory locks need a direct
 * (unpooled) connection, so `url` must already be a directUrl().
 */
async function withEnsureLock(
  url: string,
  fn: (lock: postgres.Sql) => Promise<void>,
): Promise<void> {
  const lock = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await lock`SELECT pg_advisory_lock(${ENSURE_LOCK_KEY})`;
    await fn(lock);
  } finally {
    // Ending the session releases the lock anyway; unlocking explicitly first
    // is belt-and-braces for connections that outlive us (proxies, poolers).
    await lock`SELECT pg_advisory_unlock_all()`.catch(() => {});
    await lock.end();
  }
}

/** Why a diverged database needs a schema reset, and what to do about it. */
export function divergenceMessage(
  label: string,
  local: boolean,
  target: readonly MigrationRef[],
  all: readonly MigrationRef[],
  status: MigrationStatus,
): string {
  const detail = describeStatus(status);
  const known = new Set(all.map((m) => m.name));
  const foreign = status.unknown.filter((n) => !known.has(n));
  if (status.modified.length === 0 && foreign.length === 0) {
    return (
      `${label} is already past schema version ` +
      `${target.at(-1)?.name ?? "(empty)"}; migrations only go forward.\n${detail}`
    );
  }
  if (local) {
    return (
      `${label}'s migration history diverged from this checkout, and resetting ` +
      `its schema wasn't allowed (\`pnpm db migrate\` never resets). \`pnpm db up\` ` +
      `resets it (what \`pnpm dev\` does); \`pnpm db wipe\` empties it.\n${detail}`
    );
  }
  const reset =
    "reset it from production (`pnpm db neon reset`) and migrate again";
  if (status.modified.length > 0) {
    return (
      `${label} has migrations that were edited after being applied to it, and ` +
      `migrations are never re-run or undone. If this database is ` +
      `disposable (a preview or workspace branch), ${reset}. If it holds real ` +
      `data, revert the edit and make the change in a new migration.\n${detail}`
    );
  }
  return (
    `${label} has migrations this checkout doesn't have, so applying ours could ` +
    `corrupt it. If they come from the base branch, merge it into yours. If they ` +
    `are an earlier version of one of this branch's own migrations (renamed or ` +
    `regenerated) and this database is disposable, ${reset}.\n${detail}`
  );
}

/**
 * Creates the database if it's missing. Returns false if it existed, the name
 * of the database it was cloned from, or true if it was created empty.
 */
async function createDatabaseIfMissing(
  url: string,
  cloneFrom: string | undefined,
  log: (m: string) => void,
): Promise<boolean | string> {
  const name = assertSafeName(databaseName(url));
  return withAdmin(url, async (admin) => {
    if (await databaseExists(admin, name)) return false;
    if (name === LOCAL_MAIN_DATABASE || cloneFrom === LOCAL_MAIN_DATABASE) {
      await adoptLegacyMainDatabase(admin, url, log);
      if (await databaseExists(admin, name)) return false;
    }
    if (cloneFrom && cloneFrom !== name) {
      const source = assertSafeName(cloneFrom);
      if (await databaseExists(admin, source)) {
        try {
          await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${source}"`);
          log(`Created database ${name} as a copy of ${source}.`);
          return source;
        } catch (error) {
          if (isAlreadyExists(error)) return false;
          // Most often: something (a dev server on the other branch) is
          // connected to the source, and TEMPLATE requires it be idle.
          log(
            `Couldn't clone ${source} (${(error as Error).message}); creating ${name} empty instead.`,
          );
        }
      }
    }
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    } catch (error) {
      // A concurrent ensure won the race; the database exists either way.
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    log(`Created empty database ${name}.`);
    return true;
  });
}

/** main's local database before it followed the per-branch naming. */
const LEGACY_MAIN_DATABASE = "open_minutes";

/**
 * One-time upgrade: if the legacy `open_minutes` (also docker-compose's
 * POSTGRES_DB) holds a migrated app database and main's doesn't exist yet,
 * rename it into place and leave a fresh empty `open_minutes` behind.
 * Best-effort: if it can't be renamed, main's database starts fresh.
 */
async function adoptLegacyMainDatabase(
  admin: postgres.Sql,
  url: string,
  log: (m: string) => void,
): Promise<void> {
  if (await databaseExists(admin, LOCAL_MAIN_DATABASE)) return;
  if (!(await databaseExists(admin, LEGACY_MAIN_DATABASE))) return;
  const legacy = postgres(urlForDatabase(url, LEGACY_MAIN_DATABASE), {
    max: 1,
    onnotice: () => {},
  });
  let migrated: boolean;
  try {
    const [row] = await legacy<{ migrated: boolean }[]>`
      SELECT to_regclass(${`${JOURNAL_SCHEMA}.${JOURNAL_TABLE}`}) IS NOT NULL AS migrated`;
    migrated = row!.migrated;
  } finally {
    await legacy.end();
  }
  if (!migrated) return;
  try {
    await admin.unsafe(
      `ALTER DATABASE "${LEGACY_MAIN_DATABASE}" RENAME TO "${LOCAL_MAIN_DATABASE}"`,
    );
  } catch (error) {
    if (isAlreadyExists(error)) return;
    log(
      `Couldn't rename ${LEGACY_MAIN_DATABASE} to ${LOCAL_MAIN_DATABASE} ` +
        `(${(error as Error).message}); creating a fresh one. The old data ` +
        `stays in ${LEGACY_MAIN_DATABASE}: to move it over, disconnect from it, ` +
        `drop ${LOCAL_MAIN_DATABASE}, and run \`pnpm db up\` on main again.`,
    );
    return;
  }
  log(
    `Renamed main's local database ${LEGACY_MAIN_DATABASE} to ${LOCAL_MAIN_DATABASE}, ` +
      `its new name.`,
  );
  try {
    await admin.unsafe(`CREATE DATABASE "${LEGACY_MAIN_DATABASE}"`);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  // 42P04 duplicate_database; a CREATE racing another CREATE of the same name
  // can instead trip pg_database's unique index (23505).
  const code = (error as { code?: string })?.code;
  return code === "42P04" || code === "23505";
}

/**
 * Drops everything the app and drizzle manage, leaving an empty `public`.
 * Dropping schemas rather than the database works without CREATE DATABASE and
 * keeps the lock connection alive. One simple-protocol query runs as one
 * implicit transaction, so `public` is never left missing.
 */
async function wipeSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    `DROP SCHEMA IF EXISTS public, "${JOURNAL_SCHEMA}" CASCADE; CREATE SCHEMA public`,
  );
}

async function runMigrations(
  url: string,
  target: readonly MigrationRef[],
): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle({ client, relations });
    await withMigrationsFolder(target, (migrationsFolder) =>
      migrate(db, { migrationsFolder }),
    );
  } finally {
    await client.end();
  }
}

interface DataRecord {
  name: string;
  fingerprint: string;
  appliedAt: Date;
}

async function readDataRecord(sql: postgres.Sql): Promise<DataRecord | null> {
  const [exists] = await sql`
    SELECT to_regclass(${`${JOURNAL_SCHEMA}.${DATA_STATE_TABLE}`}) IS NOT NULL AS ok`;
  if (!exists?.ok) return null;
  const [row] = await sql<DataRecord[]>`
    SELECT name, fingerprint, applied_at AS "appliedAt"
    FROM ${sql(JOURNAL_SCHEMA)}.${sql(DATA_STATE_TABLE)}`;
  return row ?? null;
}

/** Whether every table in the app's schema is empty. */
async function hasNoRows(sql: postgres.Sql): Promise<boolean> {
  const tables = await sql<{ name: string }[]>`
    SELECT quote_ident(tablename) AS name FROM pg_tables
    WHERE schemaname = 'public'`;
  if (tables.length === 0) return true;
  const [row] = await sql.unsafe(
    `SELECT ${tables
      .map((t) => `NOT EXISTS (SELECT 1 FROM public.${t.name})`)
      .join(" AND ")} AS empty`,
  );
  return row!.empty === true;
}

async function writeDataRecord(
  sql: postgres.Sql,
  data: DataState,
): Promise<void> {
  const table = sql`${sql(JOURNAL_SCHEMA)}.${sql(DATA_STATE_TABLE)}`;
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(JOURNAL_SCHEMA)}`;
  await sql`
    CREATE TABLE IF NOT EXISTS ${table} (
      id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      name text NOT NULL,
      fingerprint text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    INSERT INTO ${table} (name, fingerprint) VALUES (${data.name}, ${data.fingerprint})
    ON CONFLICT (id) DO UPDATE
      SET name = excluded.name, fingerprint = excluded.fingerprint, applied_at = now()`;
}

async function ensureData(
  lock: postgres.Sql,
  url: string,
  data: DataState,
  dataReset: ResetPolicy,
  startedEmpty: boolean,
  label: string,
  log: (m: string) => void,
): Promise<boolean> {
  const record = await readDataRecord(lock);
  const current =
    record?.name === data.name && record.fingerprint === data.fingerprint;
  if (current && dataReset !== "always") return false;
  // Empty also covers a database another entrypoint (the dev server, the om
  // CLI) migrated first without seeding: no recorded data and no rows.
  const empty =
    !current && (startedEmpty || (!record && (await hasNoRows(lock))));
  if (dataReset === "never" && !empty) {
    log(
      `Note: ${label} doesn't hold the current "${data.name}" data ` +
        `(has ${record ? `"${record.name}" ${record.fingerprint}` : "no recorded data state"}, ` +
        `declared ${data.fingerprint}). Leaving your data alone; ` +
        `\`pnpm db up --data ${data.name} --data-reset if-needed\` replaces it.`,
    );
    return false;
  }
  log(`Applying "${data.name}" data (${data.fingerprint}) to ${label}...`);
  const client = postgres(url, { onnotice: () => {} });
  try {
    await data.apply(drizzle({ client, relations }));
  } finally {
    await client.end();
  }
  await writeDataRecord(lock, data);
  return true;
}

/**
 * Read-only check that every migration this checkout expects is applied. A
 * database *ahead* of the checkout is normal mid-deploy, so that only warns.
 */
export async function assertDatabaseServesCheckout(
  url: string,
  log: (message: string) => void = (m) => console.error(m),
): Promise<void> {
  const status = await databaseStatus(url);
  const migrations = status.migrations;
  if (!migrations || migrations.pending.length > 0) {
    throw new Error(
      `The target database is missing migrations this code needs:\n` +
        `${migrations ? describeStatus(migrations) : "The database does not exist."}\n` +
        `Apply them with \`pnpm db migrate --db <target>\`, or develop against local.`,
    );
  }
  if (isDiverged(migrations)) {
    log(
      `Note: the target database is ahead of this checkout:\n${describeStatus(migrations)}`,
    );
  }
}

/**
 * Readies `url` for this checkout's code: what `pnpm db up`, `pnpm dev`, the
 * dev server and `om` run first. Local: {@link ensureDatabase}. Remote: never
 * mutated; fails if migrations are missing.
 */
export async function prepareDatabase(
  url: string,
  options: Omit<EnsureOptions, "cloneFrom"> = {},
): Promise<void> {
  if (isLocalUrl(url)) {
    await ensureDatabase(url, options);
  } else {
    await assertDatabaseServesCheckout(url, options.log);
  }
}

/** The tables `pnpm db status` counts rows of: small even in production. */
const COUNTED_TABLES = ["jurisdictions", "bodies", "meetings", "people"];

/** Exact row counts of COUNTED_TABLES; tables that don't exist are left out. */
async function countRows(sql: postgres.Sql): Promise<Record<string, number>> {
  const present = await sql<{ name: string }[]>`
    SELECT tablename AS name FROM pg_tables
    WHERE schemaname = 'public' AND tablename IN ${sql(COUNTED_TABLES)}`;
  const names = COUNTED_TABLES.filter((t) => present.some((p) => p.name === t));
  if (names.length === 0) return {};
  const [row] = await sql.unsafe(
    `SELECT ${names
      .map((t) => `(SELECT count(*) FROM public."${t}")::int AS "${t}"`)
      .join(", ")}`,
  );
  return Object.fromEntries(names.map((t) => [t, row![t] as number]));
}

export interface DatabaseStatus {
  /** On a local server: `pnpm db up` may reset its schema. */
  local: boolean;
  exists: boolean;
  migrations: MigrationStatus | null;
  appliedCount: number;
  /** The last applied migration's name: the schema version it's at. */
  schemaVersion: string | null;
  data: DataRecord | null;
  /** Row counts of the main app tables, e.g. { meetings: 12 }. */
  rowCounts: Record<string, number>;
}

/** Read-only inspection: what `ensureDatabase` would find. */
export async function databaseStatus(url: string): Promise<DatabaseStatus> {
  url = directUrl(url);
  const local = isLocalUrl(url);
  if (local) {
    const exists = await withAdmin(url, (admin) =>
      databaseExists(admin, databaseName(url)),
    );
    if (!exists) {
      return {
        local,
        exists,
        migrations: null,
        appliedCount: 0,
        schemaVersion: null,
        data: null,
        rowCounts: {},
      };
    }
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const applied = await appliedMigrations(sql);
    return {
      local,
      exists: true,
      migrations: compareMigrations(localMigrations(), applied ?? []),
      appliedCount: applied?.length ?? 0,
      schemaVersion: applied?.at(-1)?.name ?? null,
      data: await readDataRecord(sql),
      rowCounts: await countRows(sql),
    };
  } finally {
    await sql.end();
  }
}
