import { sql } from "drizzle-orm";
import type { DB } from "./index";

/**
 * Whether `name` is an IANA Area/Location zone Postgres recognizes, eg
 * "America/Anchorage". Rejects abbreviations ("PST"), POSIX offsets
 * ("EST5EDT", "Foo/Bar+3") and fixed zones ("UTC", "Etc/GMT+9"): only a named
 * place follows its legislated changes to offset and DST rules.
 *
 * Asks the database's `is_iana_timezone()`, the same function the
 * `*_timezone_valid` check constraints call, so the answer always matches what
 * an insert would accept. Use it in a check on any timezone column:
 * check("x_timezone_valid", sql`is_iana_timezone(${table.timezone})`)
 */
export async function isIanaTimezone(db: DB, name: string): Promise<boolean> {
  const [row] = (await db.execute(
    sql`SELECT is_iana_timezone(${name}) AS ok`,
  )) as unknown as { ok: boolean }[];
  return row!.ok;
}
