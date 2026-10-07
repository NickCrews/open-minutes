import { count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingBodiesTable,
  meetingsTable,
  segmentsTable,
} from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import type { SiteMeeting } from "./sites";

/** One fully ingested meeting, as listed by `om status`. */
export interface IngestedMeeting extends SiteMeeting {
  /** Slugs of the bodies that held it (eg ["gbos"]), alphabetical. */
  bodies: string[];
  title: string;
  /** "YYYY-MM-DD" in the meeting's timezone, or null if unknown. */
  date: string | null;
  /** "HH:MM:SS" in the meeting's timezone, or null if unknown. */
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
      // Correlated rather than joined, so several bodies don't multiply the
      // segment count.
      namesShort: sql<string[]>`(
        SELECT coalesce(array_agg(${bodiesTable.name_short} ORDER BY lower(${bodiesTable.name_short})), '{}')
        FROM ${meetingBodiesTable}
        JOIN ${bodiesTable} ON ${bodiesTable.id} = ${meetingBodiesTable.body_id}
        WHERE ${meetingBodiesTable.meeting_id} = ${meetingsTable.id}
      )`,
      title: meetingsTable.title,
      date: meetingsTable.date,
      time: meetingsTable.time,
      durationSecs: meetingsTable.duration_secs,
      segmentCount: count(segmentsTable.id),
    })
    .from(meetingsTable)
    .leftJoin(segmentsTable, eq(segmentsTable.meeting_id, meetingsTable.id))
    .where(
      ids && ids.length > 0 ? inArray(meetingsTable.site_id, ids) : undefined,
    )
    .groupBy(meetingsTable.id)
    .orderBy(
      desc(meetingsTable.date),
      desc(meetingsTable.time),
      desc(meetingsTable.id),
    );

  return rows.map(({ namesShort, ...row }) => ({
    ...row,
    bodies: namesShort.map((name_short) => bodySlug({ name_short })),
  }));
}
