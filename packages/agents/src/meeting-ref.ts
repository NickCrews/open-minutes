import { eq } from "drizzle-orm";
import { z } from "zod";
import { meetingsTable } from "@open-minutes/db";
import { type Db, ToolError } from "./tool";

// How every tool takes a meeting. Only the database is consulted, never the
// fixture files, so the same reference works wherever the tools run: a slug
// names a golden fixture meeting in any database that has it (dev, test, and
// prod), and an id names any meeting in one database.

export const meetingRef = z
  .union([z.int().positive(), z.string().trim().min(1)])
  .describe(
    'The meeting: its slug (eg "gbos-2026-03-23"), or its database id (eg 12). list_meetings shows both.',
  );

export type MeetingRef = z.infer<typeof meetingRef>;

// Postgres `serial` is a 4-byte int; a larger id can't exist, and comparing
// with one would be a database error rather than "not found".
const MAX_ID = 2 ** 31 - 1;

/**
 * The meeting a {@link MeetingRef} names: by slug, else by id. A slug is never
 * all digits (the `meetings_slug_not_numeric` constraint), so a reference that
 * is all digits can only be an id.
 */
export async function findMeeting(db: Db, ref: MeetingRef) {
  const text = String(ref).trim();
  const isId = /^\d+$/.test(text);
  const id = isId ? Number(text) : null;
  const [meeting] =
    id === null || id <= MAX_ID
      ? await db
          .select({
            id: meetingsTable.id,
            slug: meetingsTable.slug,
            body_id: meetingsTable.body_id,
            site_kind: meetingsTable.site_kind,
            site_id: meetingsTable.site_id,
          })
          .from(meetingsTable)
          .where(
            id === null
              ? eq(meetingsTable.slug, text)
              : eq(meetingsTable.id, id),
          )
      : [];
  if (!meeting)
    throw new ToolError(
      `No meeting with ${isId ? "id" : "slug"} ${JSON.stringify(text)}. list_meetings shows every meeting's slug and id.`,
    );
  return meeting;
}
