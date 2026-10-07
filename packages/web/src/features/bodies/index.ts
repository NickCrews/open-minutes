import { type DB, meetingCohostsTable, meetingsTable } from "@open-minutes/db";
import { compareMeetingsNewestFirst } from "@open-minutes/core/meeting-date";
import { count, eq, max, min, or, sql } from "drizzle-orm";

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
 * A subquery pairing each meeting with each body that held it: its host, and
 * any co-hosts. Join through it to count a joint meeting for every body. UNION
 * drops duplicates, so a host also listed as a co-host still pairs once.
 */
export function heldMeetings(db: DB) {
  return db
    .select({
      body_id: meetingsTable.body_id,
      meeting_id: sql<number>`${meetingsTable.id}`.as("meeting_id"),
    })
    .from(meetingsTable)
    .union(
      db
        .select({
          body_id: meetingCohostsTable.body_id,
          meeting_id: meetingCohostsTable.meeting_id,
        })
        .from(meetingCohostsTable),
    )
    .as("held");
}

/**
 * How many meetings every body has, and when the first and last of them were.
 * Joint meetings count for every body that held them.
 *
 * One grouped query rather than loading each body's meetings. A body with no
 * meetings gets no row here, so callers fall back to `NO_COVERAGE`.
 */
async function getCoverageByBody(db: DB): Promise<Map<number, Coverage>> {
  const held = heldMeetings(db);
  const rows = await db
    .select({
      body_id: held.body_id,
      meetings: count(),
      first: min(meetingsTable.date),
      last: max(meetingsTable.date),
    })
    .from(held)
    .innerJoin(meetingsTable, eq(meetingsTable.id, held.meeting_id))
    .groupBy(held.body_id);
  return new Map(rows.map(({ body_id, ...coverage }) => [body_id, coverage]));
}

/**
 * A body and its meetings, newest first: those it hosted, and the joint
 * meetings another body hosted with it. Each meeting comes with its host,
 * whose artwork it wears, and its co-hosts.
 */
export async function getBodyById(db: DB, bodyId: number) {
  const body = await db.query.bodiesTable.findFirst({
    where: { id: bodyId },
    with: { jurisdiction: true },
  });
  if (!body) throw new Error("Body not found");
  const meetings = await db.query.meetingsTable.findMany({
    where: {
      RAW: (m) =>
        or(
          eq(m.body_id, bodyId),
          sql`${m.id} IN (SELECT ${meetingCohostsTable.meeting_id} FROM ${meetingCohostsTable} WHERE ${meetingCohostsTable.body_id} = ${bodyId})`,
        )!,
    },
    with: {
      body: { columns: { id: true, name: true, name_short: true } },
      cohosts: {
        columns: { id: true, name: true, name_short: true },
        orderBy: { name: "asc" },
      },
    },
  });
  return { ...body, meetings: meetings.sort(compareMeetingsNewestFirst) };
}
