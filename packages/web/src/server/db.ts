import { neon } from "@neondatabase/serverless";
import { getRequest } from "@tanstack/solid-start/server";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import {
  getDb,
  relations,
  resolveDatabaseUrl,
  type DB,
} from "@open-minutes/db";

let neonInstance: DB | undefined;
const perRequest = new WeakMap<Request, DB>();

/**
 * Lazy server-side database handle, shared across server functions.
 *
 * Neon's HTTP driver is stateless, so one instance serves every request.
 * postgres.js holds TCP sockets, and workerd (the Cloudflare dev runtime)
 * forbids touching I/O objects created during another request, so for
 * non-Neon URLs (e.g. local dev) we open one client per request instead.
 */
export function db(): DB {
  if (neonInstance) return neonInstance;
  const url = resolveDatabaseUrl();
  if (new URL(url).hostname.endsWith(".neon.tech")) {
    // Neon speaks SQL-over-HTTP, which also works on Cloudflare Workers where
    // postgres.js's TCP sockets don't. The two drizzle instances differ only
    // in driver internals web never touches (e.g. interactive transactions),
    // so presenting both as the postgres.js-flavored DB type is safe.
    neonInstance = drizzleNeonHttp({
      client: neon(url),
      relations,
    }) as unknown as DB;
    return neonInstance;
  }
  const request = getRequest();
  let instance = perRequest.get(request);
  if (!instance) {
    instance = getDb(url).db;
    perRequest.set(request, instance);
  }
  return instance;
}
