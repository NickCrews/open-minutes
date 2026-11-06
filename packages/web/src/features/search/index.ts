import {
  bodiesTable,
  type DB,
  meetingBodiesTable,
  meetingsTable,
  peopleTable,
} from "@open-minutes/db";
import { and, desc, eq, exists, ilike, isNotNull, or, sql } from "drizzle-orm";
import { meetingBodiesColumns } from "../meetings/bodies";
import {
  type MeetingRecording,
  meetingRecordingColumns,
} from "../meetings/recording";
import { matchStrength, rankMatches, type Ranked } from "./entity-match";
import { suggestCompletions } from "./suggest";

/** Basic substring search over transcript segment text. */
export function searchSegments(db: DB, query: string) {
  return db.query.segmentsTable.findMany({
    where: { text: { ilike: `%${query}%` } },
    columns: { words: false },
    with: {
      meeting: {
        columns: {
          id: true,
          title: true,
          date: true,
          time: true,
          timezone: true,
        },
        with: { recording: meetingRecordingColumns },
      },
      person: { columns: { id: true, name: true } },
    },
    orderBy: { id: "desc" },
    limit: 50,
  });
}

/** Transcript text that might complete `query`, for search suggestions. */
export async function suggestQueries(db: DB, query: string) {
  const rows = await db.query.segmentsTable.findMany({
    where: { text: { ilike: `%${query}%` } },
    columns: { text: true },
    orderBy: { id: "desc" },
    limit: 500,
  });
  return suggestCompletions(
    rows.flatMap((row) => (row.text ? [row.text] : [])),
    query,
  );
}

/** Rows fetched per kind before ranking, so ranking has some to choose from. */
const CANDIDATE_LIMIT = 50;

/** `%term%` for ILIKE, with the query's own wildcards taken literally. */
function contains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** A person, meeting or body the query seems to name, to link straight to. */
export type EntityMatch =
  | { kind: "person"; id: number; name: string; bio: string | null }
  | {
      kind: "meeting";
      id: number;
      title: string;
      date: string | null;
      time: string | null;
      recording: MeetingRecording;
      bodies: { id: number; name: string; name_short: string }[];
    }
  | {
      kind: "body";
      id: number;
      name: string;
      name_short: string;
      jurisdiction: string;
    };

/**
 * The people, meetings and bodies that `query` most likely names, best first.
 * A meeting matches on its title or the names of the bodies that held it, so
 * "gbos march" finds the GBOS meetings in March.
 */
export async function searchEntities(
  db: DB,
  query: string,
): Promise<EntityMatch[]> {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const bodyNamed = (term: string) =>
    or(
      ilike(bodiesTable.name, contains(term)),
      ilike(bodiesTable.name_short, contains(term)),
    );
  const [people, bodies, meetingIds] = await Promise.all([
    db
      .select({
        id: peopleTable.id,
        name: peopleTable.name,
        bio: peopleTable.bio,
      })
      .from(peopleTable)
      .where(
        and(
          isNotNull(peopleTable.name),
          ...terms.map((t) => ilike(peopleTable.name, contains(t))),
        ),
      )
      .limit(CANDIDATE_LIMIT),
    db.query.bodiesTable.findMany({
      columns: { id: true, name: true, name_short: true },
      with: { jurisdiction: { columns: { name: true } } },
    }),
    db
      .select({ id: meetingsTable.id })
      .from(meetingsTable)
      .where(
        and(
          ...terms.map((t) =>
            or(
              ilike(meetingsTable.title, contains(t)),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(meetingBodiesTable)
                  .innerJoin(
                    bodiesTable,
                    eq(bodiesTable.id, meetingBodiesTable.body_id),
                  )
                  .where(
                    and(
                      eq(meetingBodiesTable.meeting_id, meetingsTable.id),
                      bodyNamed(t),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )
      .orderBy(
        sql`${meetingsTable.date} DESC NULLS LAST`,
        desc(meetingsTable.id),
      )
      .limit(CANDIDATE_LIMIT),
  ]);
  const meetings = meetingIds.length
    ? await db.query.meetingsTable.findMany({
        where: { id: { in: meetingIds.map((m) => m.id) } },
        columns: {
          id: true,
          title: true,
          date: true,
          time: true,
        },
        with: {
          bodies: meetingBodiesColumns,
          recording: meetingRecordingColumns,
        },
      })
    : [];
  const meetingOrder = new Map(meetingIds.map((m, i) => [m.id, i]));
  meetings.sort((a, b) => meetingOrder.get(a.id)! - meetingOrder.get(b.id)!);

  function ranked<T>(
    items: T[],
    names: (item: T) => string[],
    toMatch: (item: T) => EntityMatch,
  ): Ranked<EntityMatch>[] {
    return items.flatMap((item) => {
      const strength = matchStrength(names(item), query);
      return strength === null ? [] : [{ item: toMatch(item), strength }];
    });
  }
  // Bodies first on a tie: there are few of them, and a query that names one
  // equally names every meeting it held.
  return rankMatches([
    ranked(
      bodies,
      (b) => [b.name, b.name_short],
      (b) => ({
        kind: "body",
        id: b.id,
        name: b.name,
        name_short: b.name_short,
        jurisdiction: b.jurisdiction.name,
      }),
    ),
    ranked(
      people,
      (p) => [p.name ?? ""],
      (p) => ({ kind: "person", id: p.id, name: p.name ?? "", bio: p.bio }),
    ),
    ranked(
      meetings,
      (m) => [m.title, ...m.bodies.flatMap((b) => [b.name, b.name_short])],
      (m) => ({ kind: "meeting", ...m }),
    ),
  ]);
}

/** Everything the search bar previews for `query`. */
export async function searchPreview(db: DB, query: string) {
  const [entities, queries] = await Promise.all([
    searchEntities(db, query),
    suggestQueries(db, query),
  ]);
  return { entities, queries };
}
