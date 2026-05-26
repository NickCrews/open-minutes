// Drop everything Drizzle manages and recreate an empty schema, so the next
// `drizzle-kit migrate` can rebuild from a clean slate. This is the recovery
// path for a drifted migration history: when the recorded journal hashes no
// longer match the migration files, an incremental `drizzle-kit migrate` fails
// (e.g. trying to re-CREATE an enum that already exists). The `db:nuke` script
// chains this with `drizzle-kit migrate` to leave the schema at the latest
// migration.
//
// Plain JavaScript (not TypeScript) so it runs under bare `node` using only
// gbos-core's existing `postgres` and `dotenv` dependencies — no extra runner.
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import postgres from "postgres";

// Mirror drizzle.config.ts: load .env.local from the workspace root so this
// targets the same DATABASE_URL as the migrations.
config({
  path: join(dirname(fileURLToPath(import.meta.url)), "../../../../.env.local"),
});

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL must be set (in .env.local or the environment)",
  );
}

const sql = postgres(url);
try {
  // `public` holds the application tables, types, and extensions; `drizzle`
  // holds the migration journal. Dropping both, then recreating an empty
  // `public`, leaves a clean database for the migration history to reapply.
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sql`CREATE SCHEMA public`;
  process.stdout.write(
    "Nuked schema (dropped public + drizzle, recreated public).\n",
  );
} finally {
  await sql.end();
}
