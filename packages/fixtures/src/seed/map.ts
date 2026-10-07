import { bodiesTable, jurisdictionsTable } from "@open-minutes/db";
import type { GoldenMeeting, TestData } from "../test-data";

type JurisdictionInsert = typeof jurisdictionsTable.$inferInsert;
type BodyInsert = typeof bodiesTable.$inferInsert;

export interface MappedRows {
  jurisdictions: JurisdictionInsert[];
  bodies: BodyInsert[];
  /**
   * Resolves a snapshot body id (e.g. "gbos") to its assigned serial primary
   * key. This is the seam later slices use to wire up foreign keys (meetings →
   * bodies) without a database round-trip.
   */
  bodyIdByKey: ReadonlyMap<string, number>;
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
  const jurisdictionIdByKey = new Map<string, number>();
  const jurisdictions = data.jurisdictions.map((j, i): JurisdictionInsert => {
    const id = i + 1;
    jurisdictionIdByKey.set(j.id, id);
    return {
      id,
      name: j.name,
      name_short: j.name_short,
      state: j.state,
    };
  });

  const bodyIdByKey = new Map<string, number>();
  const bodies = data.bodies.map((b, i): BodyInsert => {
    const id = i + 1;
    bodyIdByKey.set(b.id, id);
    const jurisdictionId = jurisdictionIdByKey.get(b.jurisdiction_id);
    if (jurisdictionId === undefined)
      throw new Error(
        `Body "${b.id}" references unknown jurisdiction "${b.jurisdiction_id}"`,
      );
    return {
      id,
      jurisdiction_id: jurisdictionId,
      name: b.name,
      name_short: b.name_short,
      timezone: b.timezone,
      meeting_source: b.meeting_source ?? null,
    };
  });

  return { jurisdictions, bodies, bodyIdByKey };
}

/**
 * The database ids of a golden meeting's bodies, from their snapshot ids.
 * Throws on one bodies.jsonl doesn't have.
 */
export function meetingBodyIds(
  meeting: Pick<GoldenMeeting, "slug" | "body_ids">,
  bodyIdByKey: ReadonlyMap<string, number>,
): number[] {
  return meeting.body_ids.map((key) => {
    const id = bodyIdByKey.get(key);
    if (id === undefined)
      throw new Error(`Meeting ${meeting.slug} has unknown body "${key}"`);
    return id;
  });
}
