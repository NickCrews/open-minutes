import { type DB } from "@open-minutes/db";
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
