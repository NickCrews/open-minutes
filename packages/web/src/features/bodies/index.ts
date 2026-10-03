import { type DB, meetingsTable } from "@open-minutes/db";
import { count, desc, max, min, ne, sql } from "drizzle-orm";

/** How much of a body's record we hold: its meetings, and the span they cover. */
export type Coverage = {
  meetings: number;
  /** Null when none of the meetings has a known date. */
  first: string | null;
  last: string | null;
};

const NO_COVERAGE: Coverage = { meetings: 0, first: null, last: null };

export async function getAllBodies(db: DB) {
  const [bodies, coverage, latestVideos] = await Promise.all([
    db.query.bodiesTable.findMany({
      with: { jurisdiction: true },
      orderBy: { name: "asc" },
    }),
    getCoverageByBody(db),
    getLatestVideoByBody(db),
  ]);
  return bodies.map((body) => ({
    ...body,
    coverage: coverage.get(body.id) ?? NO_COVERAGE,
    /** The video whose thumbnail stands for the body, if it has one. */
    thumbnail_youtube_id: latestVideos.get(body.id) ?? null,
  }));
}

/**
 * The YouTube id of each body's most recent meeting that has a video, for
 * the body's thumbnail: a body's videos tend to share a look (the same
 * chamber, the same title card), so its latest one stands for it. Meetings
 * with no date count as oldest, and a body with no videos gets no entry.
 */
async function getLatestVideoByBody(db: DB): Promise<Map<number, string>> {
  const rows = await db
    .selectDistinctOn([meetingsTable.body_id], {
      body_id: meetingsTable.body_id,
      youtube_id: meetingsTable.youtube_id,
    })
    .from(meetingsTable)
    .where(ne(meetingsTable.youtube_id, ""))
    .orderBy(
      meetingsTable.body_id,
      sql`${meetingsTable.date} DESC NULLS LAST`,
      sql`${meetingsTable.time} DESC NULLS LAST`,
      desc(meetingsTable.id),
    );
  return new Map(rows.map((r) => [r.body_id, r.youtube_id]));
}

/**
 * How many meetings every body has, and when the first and last of them were.
 *
 * One grouped query rather than loading each body's meetings. A body with no
 * meetings gets no row here, so callers fall back to `NO_COVERAGE`.
 */
async function getCoverageByBody(db: DB): Promise<Map<number, Coverage>> {
  const rows = await db
    .select({
      body_id: meetingsTable.body_id,
      meetings: count(),
      first: min(meetingsTable.date),
      last: max(meetingsTable.date),
    })
    .from(meetingsTable)
    .groupBy(meetingsTable.body_id);
  return new Map(rows.map(({ body_id, ...coverage }) => [body_id, coverage]));
}

export function getBodyById(db: DB, bodyId: number) {
  return db.query.bodiesTable
    .findFirst({
      where: { id: bodyId },
      with: {
        jurisdiction: true,
        videoSources: true,
        meetings: {
          orderBy: { date: "desc", time: "desc" },
        },
      },
    })
    .then((body) => {
      if (!body) throw new Error("Body not found");
      return body;
    });
}
