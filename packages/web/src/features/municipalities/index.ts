import { type DB } from "@open-minutes/core/db";

export function getAllMunicipalities(db: DB) {
  return db.query.municipalitiesTable.findMany({
    orderBy: { name: "asc" },
  });
}

export function getMunicipalityById(db: DB, municipalityId: number) {
  return db.query.municipalitiesTable
    .findFirst({
      where: { id: municipalityId },
      with: {
        meetings: {
          orderBy: { start_time: "desc" },
        },
      },
    })
    .then((municipality) => {
      if (!municipality) throw new Error("Municipality not found");
      return municipality;
    });
}
