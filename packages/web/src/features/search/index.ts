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
          site_kind: true,
          site_id: true,
          timezone: true,
        },
      },
      person: { columns: { id: true, name: true } },
    },
    orderBy: { id: "desc" },
    limit: 50,
  });
}
