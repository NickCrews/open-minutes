import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import {
  getDb,
  relations,
  resolveDatabaseUrl,
  type DB,
} from "@open-minutes/core/db";

let instance: DB | undefined;

/** Lazy server-side database singleton, shared across server functions. */
export function db(): DB {
  instance ??= connect();
  return instance;
}

function connect(): DB {
  const url = resolveDatabaseUrl();
  if (new URL(url).hostname.endsWith(".neon.tech")) {
    // Neon speaks SQL-over-HTTP, which also works on Cloudflare Workers where
    // postgres.js's TCP sockets don't. The two drizzle instances differ only
    // in driver internals web never touches (e.g. interactive transactions),
    // so presenting both as the postgres.js-flavored DB type is safe.
    return drizzleNeonHttp({ client: neon(url), relations }) as unknown as DB;
  }
  return getDb(url).db;
}
