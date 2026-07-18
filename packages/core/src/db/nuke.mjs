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
import process from "node:process";
import { URL } from "node:url";
import postgres from "postgres";
import { resolveDatabaseUrl } from "./resolve.mjs";

const url = resolveDatabaseUrl();

// Nuking the wrong database is unrecoverable, so remote targets (e.g.
// DB=prod) must opt in explicitly.
const host = new URL(url).hostname;
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) &&
  process.env.ALLOW_REMOTE_NUKE !== "1"
) {
  throw new Error(
    `Refusing to nuke non-local database at ${host}. Set ALLOW_REMOTE_NUKE=1 to override.`,
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
