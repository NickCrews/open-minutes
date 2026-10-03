import { type DB } from "@open-minutes/db";

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
          youtube_id: true,
        },
        with: { body: { columns: { timezone: true } } },
      },
      person: { columns: { id: true, name: true } },
    },
    orderBy: { id: "desc" },
    limit: 50,
  });
}
