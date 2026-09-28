/**
 * Short identifier for a body (eg "gbos"), used for `--body` CLI filters and
 * per-meeting work-directory names like `gbos_9HoIM5INxpI`.
 */
export function bodySlug(body: { name_short: string }): string {
  return body.name_short.toLowerCase();
}
