import { count, desc, eq, inArray } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingsTable,
  segmentsTable,
} from "@open-minutes/core/db";
import { bodySlug } from "@open-minutes/core/bodies";

/** One fully ingested meeting, as listed by `om status`. */
export interface IngestedMeeting {
  youtubeId: string;
  /** Body slug (eg "gbos"). */
  body: string;
  title: string;
  startTime: Date | null;
  /** Postgres interval rendering (eg "01:23:45"), or null if unknown. */
  durationSecs: string | null;
  segmentCount: number;
}

/**
 * The meetings ingested in the database, newest first. A meeting row existing
 * means fully ingested (there is no partial state — see ingestVideo's
 * all-or-nothing commit). Pass `ids` to filter to specific YouTube video IDs.
 */
export async function listIngested(
  db: DB,
  ids?: string[],
): Promise<IngestedMeeting[]> {
  const rows = await db
    .select({
      youtubeId: meetingsTable.youtube_id,
      nameShort: bodiesTable.name_short,
      title: meetingsTable.title,
      startTime: meetingsTable.start_time,
      durationSecs: meetingsTable.duration_secs,
      segmentCount: count(segmentsTable.id),
    })
    .from(meetingsTable)
    .innerJoin(bodiesTable, eq(meetingsTable.body_id, bodiesTable.id))
    .leftJoin(segmentsTable, eq(segmentsTable.meeting_id, meetingsTable.id))
    .where(
      ids && ids.length > 0
        ? inArray(meetingsTable.youtube_id, ids)
        : undefined,
    )
    .groupBy(meetingsTable.id, bodiesTable.id)
    .orderBy(desc(meetingsTable.start_time), desc(meetingsTable.id));

  return rows.map(({ nameShort, ...row }) => ({
    ...row,
    body: bodySlug({ name_short: nameShort }),
  }));
}
