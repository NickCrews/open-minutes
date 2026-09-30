import { type DB } from "@open-minutes/db";

export function getAllBodies(db: DB) {
  return db.query.bodiesTable.findMany({
    with: { jurisdiction: true },
    orderBy: { name: "asc" },
  });
}

export function getBodyById(db: DB, bodyId: number) {
  return db.query.bodiesTable
    .findFirst({
      where: { id: bodyId },
      with: {
        jurisdiction: true,
        videoSources: true,
        meetings: {
          orderBy: { date: "desc", time: "desc" },
        },
      },
    })
    .then((body) => {
      if (!body) throw new Error("Body not found");
      return body;
    });
}
