import { type DB, meetingsTable } from "@open-minutes/core/db";
import { count, max, min } from "drizzle-orm";

/** How much of a body's record we hold: its meetings, and the span they cover. */
export type Coverage = {
  meetings: number;
  /** Null when none of the meetings has a known start time. */
  first: Date | null;
  last: Date | null;
};

const NO_COVERAGE: Coverage = { meetings: 0, first: null, last: null };

export async function getAllBodies(db: DB) {
  const [bodies, coverage] = await Promise.all([
    db.query.bodiesTable.findMany({
      with: { jurisdiction: true },
      orderBy: { name: "asc" },
    }),
    getCoverageByBody(db),
  ]);
  return bodies.map((body) => ({
    ...body,
    coverage: coverage.get(body.id) ?? NO_COVERAGE,
  }));
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
      first: min(meetingsTable.start_time),
      last: max(meetingsTable.start_time),
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
