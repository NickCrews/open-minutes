import {
  type DB,
  isTranscribed,
  meetingBodiesTable,
  meetingsTable,
  transcribedWhere,
} from "@open-minutes/db";
import { compareMeetingsNewestFirst } from "@open-minutes/core/meeting-date";
import { count, eq, max, min } from "drizzle-orm";
import { meetingBodiesColumns } from "../meetings/bodies";

/** How much of a body's record we hold: its meetings, and the span they cover. */
export type Coverage = {
  meetings: number;
  /** Null when none of the meetings has a known date. */
  first: string | null;
  last: string | null;
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
 * Joint meetings count for every body that held them.
 *
 * One grouped query rather than loading each body's meetings. A body with no
 * meetings gets no row here, so callers fall back to `NO_COVERAGE`.
 */
async function getCoverageByBody(db: DB): Promise<Map<number, Coverage>> {
  const rows = await db
    .select({
      body_id: meetingBodiesTable.body_id,
      meetings: count(),
      first: min(meetingsTable.date),
      last: max(meetingsTable.date),
    })
    .from(meetingBodiesTable)
    .innerJoin(
      meetingsTable,
      eq(meetingsTable.id, meetingBodiesTable.meeting_id),
    )
    .where(isTranscribed)
    .groupBy(meetingBodiesTable.body_id);
  return new Map(rows.map(({ body_id, ...coverage }) => [body_id, coverage]));
}

/**
 * A body and its meetings, newest first, joint ones included. Each meeting
 * comes with all the bodies that held it.
 */
export async function getBodyById(db: DB, bodyId: number) {
  const body = await db.query.bodiesTable.findFirst({
    where: { id: bodyId },
    with: {
      jurisdiction: true,
      meetings: {
        where: transcribedWhere,
        with: { bodies: meetingBodiesColumns },
      },
    },
  });
  if (!body) throw new Error("Body not found");
  return { ...body, meetings: body.meetings.sort(compareMeetingsNewestFirst) };
}
