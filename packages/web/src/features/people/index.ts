import { type DB, peopleTable } from "@open-minutes/core/db";
import { eq } from "drizzle-orm";

export function getAllPeople(db: DB) {
  return db.query.peopleTable.findMany({
    columns: { voice_embedding: false },
    orderBy: { name: "asc" },
  });
}

export function updatePersonName(db: DB, personId: number, name: string) {
  return db
    .update(peopleTable)
    .set({ name })
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
