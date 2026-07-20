import {
  bodiesTable,
  type DB,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/core/db";
import { countDistinct, desc, eq, isNotNull, max, min } from "drizzle-orm";

/** One body a person has spoken before, and the span over which they did. */
export type Attendance = {
  body: string;
  /** The body's timezone, which is what `first`/`last` should be read in. */
  timezone: string;
  meetings: number;
  /** Null when none of the meetings has a known start time. */
  first: Date | null;
  last: Date | null;
};

export async function getAllPeople(db: DB) {
  const [people, attendance] = await Promise.all([
    db.query.peopleTable.findMany({
      columns: { voice_embedding: false },
      orderBy: { name: "asc" },
    }),
    getAttendanceByPerson(db),
  ]);
  return people.map((person) => ({
    ...person,
    attendance: attendance.get(person.id) ?? [],
  }));
}

/**
 * How many meetings of each body every person has spoken in, and when the first
 * and last of those were.
 *
 * Aggregated in SQL rather than by loading segments: a prolific speaker has
 * thousands of them, and this feeds a one-line summary per person.
 */
async function getAttendanceByPerson(
  db: DB,
): Promise<Map<number, Attendance[]>> {
  const rows = await db
    .select({
      person_id: segmentsTable.person_id,
      body: bodiesTable.name_short,
      timezone: bodiesTable.timezone,
      // Distinct, because one meeting yields many segments per speaker.
      meetings: countDistinct(segmentsTable.meeting_id),
      first: min(meetingsTable.start_time),
      last: max(meetingsTable.start_time),
    })
    .from(segmentsTable)
    .innerJoin(meetingsTable, eq(segmentsTable.meeting_id, meetingsTable.id))
    .innerJoin(bodiesTable, eq(meetingsTable.body_id, bodiesTable.id))
    // Unidentified segments belong to no one; they'd otherwise group as a person.
    .where(isNotNull(segmentsTable.person_id))
    .groupBy(segmentsTable.person_id, bodiesTable.id)
    // Most-attended body first, so a summary truncated to one body names the
    // one the person is actually known for.
    .orderBy(desc(countDistinct(segmentsTable.meeting_id)));

  const byPerson = new Map<number, Attendance[]>();
  for (const row of rows) {
    // person_id is non-null by the WHERE above, which the column type can't know.
    const list = byPerson.get(row.person_id!) ?? [];
    list.push({
      body: row.body,
      timezone: row.timezone,
      meetings: row.meetings,
      first: row.first,
      last: row.last,
    });
    byPerson.set(row.person_id!, list);
  }
  return byPerson;
}

/**
 * Sets a person's name, or clears it back to unidentified when `name` is blank.
 * Clearing is a real affordance: it undoes a misidentification and returns the
 * speaker to an anonymous placeholder in every transcript.
 */
export function updatePersonName(db: DB, personId: number, name: string) {
  return db
    .update(peopleTable)
    .set({ name: name.trim() || null })
    .where(eq(peopleTable.id, personId));
}

/**
 * Sets a person's free-form bio, or clears it when `bio` is blank. Blank stores
 * NULL rather than "", so "never written" and "deliberately emptied" don't have
 * to be told apart downstream.
 */
export function updatePersonBio(db: DB, personId: number, bio: string) {
  return db
    .update(peopleTable)
    .set({ bio: bio.trim() || null })
    .where(eq(peopleTable.id, personId));
}

export function getPersonById(db: DB, personId: number) {
  return db.query.peopleTable
    .findFirst({
      where: { id: personId },
      columns: { voice_embedding: false },
      with: {
        segments: {
          columns: { words: false },
          with: {
            meeting: {
              columns: {
                id: true,
                title: true,
                start_time: true,
                youtube_id: true,
              },
              with: { body: { columns: { timezone: true } } },
            },
          },
          orderBy: { id: "desc" },
          limit: 100,
        },
      },
    })
    .then((person) => {
      if (!person) throw new Error("Person not found");
      return person;
    });
}
