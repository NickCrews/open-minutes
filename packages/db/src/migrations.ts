import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type postgres from "postgres";
import {
  JOURNAL_SCHEMA,
  JOURNAL_TABLE,
  type MigrationRef,
} from "./migration-status";

export const MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

/**
 * The migrations in this checkout, named and hashed exactly as drizzle's
 * migrator records them in its journal.
 */
export function localMigrations(
  folder: string = MIGRATIONS_FOLDER,
): MigrationRef[] {
  return readMigrationFiles({ migrationsFolder: folder }).map((m) => ({
    name: m.name!,
    hash: m.hash,
  }));
}

/**
 * Names a point in the migration history: "latest", or one migration, by its
 * full folder name (`20260719061307_split-munis-into-jurisdictions-and-bodies`),
 * its timestamp (`20260719061307`), or its tag (`split-munis-into-jurisdictions-and-bodies`).
 * The schema "at" a version is every migration up to and including it.
 * Migrations are append-only, so a version names the same schema forever.
 */
export type SchemaVersion = "latest" | (string & {});

/** The full folder name a version refers to. Throws if unknown or ambiguous. */
export function resolveSchemaVersion(
  version: SchemaVersion,
  all: readonly MigrationRef[] = localMigrations(),
): string {
  if (version === "latest") {
    const last = all.at(-1);
    if (!last) throw new Error("There are no migrations.");
    return last.name;
  }
  const matches = all.filter(
    (m) =>
      m.name === version ||
      m.name.slice(0, 14) === version ||
      m.name.slice(15) === version,
  );
  if (matches.length === 1) return matches[0]!.name;
  throw new Error(
    matches.length === 0
      ? `Unknown schema version "${version}". Expected "latest" or one of:\n${all.map((m) => `  ${m.name}`).join("\n")}`
      : `Ambiguous schema version "${version}": matches ${matches.map((m) => m.name).join(", ")}`,
  );
}

/** The migrations that make up the schema at `version`, in order. */
export function migrationsUpTo(
  version: SchemaVersion = "latest",
  all: readonly MigrationRef[] = localMigrations(),
): MigrationRef[] {
  if (version === "latest") return [...all];
  const name = resolveSchemaVersion(version, all);
  return all.slice(0, all.findIndex((m) => m.name === name) + 1);
}

/**
 * Runs `fn` with a migrations folder holding only `migrations` (symlinks into
 * the real folder), so drizzle's own migrator can stop at a given version.
 */
export async function withMigrationsFolder<T>(
  migrations: readonly MigrationRef[],
  fn: (folder: string) => Promise<T>,
): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), "om-migrations-"));
  try {
    for (const m of migrations) {
      symlinkSync(join(MIGRATIONS_FOLDER, m.name), join(folder, m.name), "dir");
    }
    return await fn(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Short, stable digest identifying a set of migrations (the schema version). */
export function migrationsFingerprint(
  migrations: readonly MigrationRef[] = localMigrations(),
): string {
  const hash = createHash("sha256");
  for (const m of migrations) hash.update(`${m.name}\0${m.hash}\n`);
  return hash.digest("hex").slice(0, 12);
}

/**
 * The migrations recorded in a database's drizzle journal, or `null` when the
 * database has no journal at all (it has never been migrated).
 */
export async function appliedMigrations(
  sql: postgres.Sql,
): Promise<{ name: string | null; hash: string }[] | null> {
  const [exists] = await sql`
    SELECT to_regclass(${`${JOURNAL_SCHEMA}.${JOURNAL_TABLE}`}) IS NOT NULL AS ok`;
  if (!exists?.ok) return null;
  return await sql<{ name: string | null; hash: string }[]>`
    SELECT name, hash FROM ${sql(JOURNAL_SCHEMA)}.${sql(JOURNAL_TABLE)}
    ORDER BY id`;
}
