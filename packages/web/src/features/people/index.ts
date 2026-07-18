import { type DB } from "@open-minutes/core/db";

export function getAllPeople(db: DB) {
  return db.query.peopleTable.findMany({
    columns: { voice_embedding: false },
    orderBy: { name: "asc" },
  });
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
              columns: { id: true, title: true, start_time: true },
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
