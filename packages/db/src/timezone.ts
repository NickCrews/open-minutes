import { sql } from "drizzle-orm";
import type { DB } from "./index";

/**
 * Why `name` isn't an IANA Area/Location zone Postgres recognizes, eg
 * "America/Anchorage", as a message fit to show a user; null if it is one.
 * Rejects abbreviations ("PST"), POSIX offsets ("EST5EDT", "Foo/Bar+3") and
 * fixed zones ("UTC", "Etc/GMT+9"): only a named place follows its legislated
 * changes to offset and DST rules.
 *
 * Asks the database's `iana_timezone_error()`, the same function the
 * `*_timezone_valid` check constraints call, so the answer always matches what
 * an insert would accept. Use it in a check on any timezone column:
 * check("x_timezone_valid", sql`iana_timezone_error(${table.timezone}) IS NULL`)
 */
export async function ianaTimezoneError(
  db: Pick<DB, "execute">,
  name: string,
): Promise<string | null> {
  const [row] = (await db.execute(
    sql`SELECT iana_timezone_error(${name}) AS error`,
  )) as unknown as { error: string | null }[];
  return row!.error;
}
