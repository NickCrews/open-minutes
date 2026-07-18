import { count, desc, eq, inArray } from "drizzle-orm";
import {
  type DB,
  meetingsTable,
  municipalitiesTable,
  segmentsTable,
} from "@open-minutes/core/db";
import { muniSlug } from "@open-minutes/core/munis";

/** One fully ingested meeting, as listed by `om status`. */
export interface IngestedMeeting {
  youtubeId: string;
  /** Municipality slug (eg "gbos"). */
  muni: string;
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
      nameShort: municipalitiesTable.name_short,
      title: meetingsTable.title,
      startTime: meetingsTable.start_time,
      durationSecs: meetingsTable.duration_secs,
      segmentCount: count(segmentsTable.id),
    })
    .from(meetingsTable)
    .innerJoin(
      municipalitiesTable,
      eq(meetingsTable.municipality_id, municipalitiesTable.id),
    )
    .leftJoin(segmentsTable, eq(segmentsTable.meeting_id, meetingsTable.id))
    .where(
      ids && ids.length > 0
        ? inArray(meetingsTable.youtube_id, ids)
        : undefined,
    )
    .groupBy(meetingsTable.id, municipalitiesTable.id)
    .orderBy(desc(meetingsTable.start_time), desc(meetingsTable.id));

  return rows.map(({ nameShort, ...row }) => ({
    ...row,
    muni: muniSlug({ name_short: nameShort }),
  }));
}
