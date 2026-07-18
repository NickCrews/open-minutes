import { getDb, type DB } from "@open-minutes/core/db";

let instance: DB | undefined;

/** Lazy server-side database singleton, shared across server functions. */
export function db(): DB {
  instance ??= getDb().db;
  return instance;
}
