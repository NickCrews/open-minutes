import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { relations } from "./schema";
import { resolveDatabaseUrl } from "./resolve.mjs";

/**
 * Connects to a database. `target` is a name like "local" or "prod" (resolved
 * via DATABASE_URL_<NAME> in the root .env.local), a full postgres:// URL, or
 * omitted to use $DB (falling back to $DATABASE_URL, then "local").
 */
export function getDb(target?: string) {
  const url = resolveDatabaseUrl(target);
  const client = postgres(url);
  const db = drizzle({ client, relations });
  return { db, client };
}

export type DB = ReturnType<typeof getDb>["db"];

export { resolveDatabaseUrl } from "./resolve.mjs";
export * from "./schema";
