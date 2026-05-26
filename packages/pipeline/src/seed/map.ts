import { municipalitiesTable } from "@gbos/core/db";
import type { TestData } from "../test-utils/test-data";

type MunicipalityInsert = typeof municipalitiesTable.$inferInsert;

export interface MappedRows {
  municipalities: MunicipalityInsert[];
  /**
   * Resolves a snapshot municipality id (e.g. "gbos") to its assigned serial
   * primary key. This is the seam later slices use to wire up foreign keys
   * (meetings → municipalities) without a database round-trip.
   */
  municipalityIdByKey: ReadonlyMap<string, number>;
}

/**
 * Convert the in-memory `test-data/` snapshot into insert-ready rows. Pure: no
 * database access, no I/O.
 *
 * Serial primary keys are assigned explicitly here, 1-based in snapshot (file)
 * order, so that (a) foreign keys can be resolved before anything is inserted
 * and (b) the same snapshot always produces the same keys across reseeds —
 * `/meetings/1` keeps pointing at the same meeting. The seeder truncates with
 * `RESTART IDENTITY` before inserting, so these explicit ids start from a clean
 * sequence rather than colliding with leftover serial state.
 */
export function mapSnapshot(data: TestData): MappedRows {
  const municipalityIdByKey = new Map<string, number>();
  const municipalities = data.municipalities.map((m, i): MunicipalityInsert => {
    const id = i + 1;
    municipalityIdByKey.set(m.id, id);
    return {
      id,
      name: m.name,
      name_short: m.name_short,
      state: m.state,
      youtube_channel_id: m.youtube_channel_id,
    };
  });

  return { municipalities, municipalityIdByKey };
}
