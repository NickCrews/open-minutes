import { type DB, peopleTable } from "@open-minutes/core/db";
import { eq } from "drizzle-orm";

export function getAllPeople(db: DB) {
  return db.query.peopleTable.findMany({
    columns: { voice_embedding: false },
    orderBy: { name: "asc" },
  });
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
