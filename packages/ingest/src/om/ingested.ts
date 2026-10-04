import { count, desc, eq, inArray } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingsTable,
  segmentsTable,
} from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import type { SiteMeeting } from "./sites";

/** One fully ingested meeting, as listed by `om status`. */
export interface IngestedMeeting extends SiteMeeting {
  /** Body slug (eg "gbos"). */
  body: string;
  title: string;
  /** "YYYY-MM-DD" in the body's timezone, or null if unknown. */
  date: string | null;
  /** "HH:MM:SS" in the body's timezone, or null if unknown. */
  time: string | null;
  /** Postgres interval rendering (eg "01:23:45"), or null if unknown. */
  durationSecs: string | null;
  segmentCount: number;
}

/**
 * The meetings ingested in the database, newest first. A meeting row existing
 * means fully ingested (there is no partial state — see ingestMeeting's
 * all-or-nothing commit). Pass `ids` to filter to meetings with those IDs on
 * their sites (`meetings.site_id`).
 */
export async function listIngested(
  db: DB,
  ids?: string[],
): Promise<IngestedMeeting[]> {
  const rows = await db
    .select({
      siteKind: meetingsTable.site_kind,
      siteId: meetingsTable.site_id,
      nameShort: bodiesTable.name_short,
      title: meetingsTable.title,
      date: meetingsTable.date,
      time: meetingsTable.time,
      durationSecs: meetingsTable.duration_secs,
      segmentCount: count(segmentsTable.id),
    })
    .from(meetingsTable)
    .innerJoin(bodiesTable, eq(meetingsTable.body_id, bodiesTable.id))
    .leftJoin(segmentsTable, eq(segmentsTable.meeting_id, meetingsTable.id))
    .where(
      ids && ids.length > 0 ? inArray(meetingsTable.site_id, ids) : undefined,
    )
    .groupBy(meetingsTable.id, bodiesTable.id)
    .orderBy(
      desc(meetingsTable.date),
      desc(meetingsTable.time),
      desc(meetingsTable.id),
    );

  return rows.map(({ nameShort, ...row }) => ({
    ...row,
    body: bodySlug({ name_short: nameShort }),
  }));
}
