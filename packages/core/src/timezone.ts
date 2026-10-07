/**
 * Why `tz` isn't an IANA Area/Location zone, eg "America/Anchorage", as a
 * message fit to show a user; null if it is one.
 *
 * A TypeScript copy of the database's `iana_timezone_error()`, which the
 * `*_timezone_valid` check constraints call and which stays the canonical
 * check. This one needs no database, for checking input before it gets
 * there (fixture files, a form). It makes the same three checks, in the same
 * order, with the same messages; the last asks the JS runtime's zone
 * database (ICU) rather than Postgres's, so the two could disagree on a zone
 * one of them is too old to know. packages/db/src/timezone.test.ts runs the
 * same cases through both.
 */
export function ianaTimezoneError(tz: string): string | null {
  if (tz.startsWith("Etc/"))
    return `"${tz}" is a fixed UTC offset. Use the zone of a place, like "America/Anchorage", so daylight saving time and changes to local time law apply.`;
  if (!/^[A-Za-z_]+(\/[A-Za-z_-]+)+$/.test(tz))
    return `"${tz}" is not an IANA time zone name. Use the zone of a place, like "America/Anchorage".`;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return null;
  } catch {
    return `"${tz}" is not a known time zone. Check the spelling, eg "America/Anchorage".`;
  }
}
