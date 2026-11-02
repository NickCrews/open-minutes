import { bodiesTable, jurisdictionsTable } from "@open-minutes/db";
import type {
  GoldenBody,
  GoldenJurisdiction,
  GoldenMeeting,
} from "@open-minutes/datasets/datums";

type JurisdictionInsert = typeof jurisdictionsTable.$inferInsert;
type BodyInsert = typeof bodiesTable.$inferInsert;

export interface MappedRows {
  jurisdictions: JurisdictionInsert[];
  bodies: BodyInsert[];
  /**
   * Resolves a body slug (e.g. "gbos") to its assigned serial primary key,
   * so meetings can reference bodies without a database round-trip.
   */
  bodyIdBySlug: ReadonlyMap<string, number>;
}

/**
 * Convert the datums' jurisdictions and bodies into insert-ready rows.
 * Pure: no database access, no I/O.
 *
 * Serial primary keys are assigned explicitly here, 1-based in file order, so
 * that (a) foreign keys can be resolved before anything is inserted and (b)
 * the same files always produce the same keys across reseeds —
 * `/bodies/1` keeps pointing at the same body. The seeder truncates with
 * `RESTART IDENTITY` before inserting, so these explicit ids start from a clean
 * sequence rather than colliding with leftover serial state.
 */
export function bodyRows(
  jurisdictionsIn: readonly GoldenJurisdiction[],
  bodiesIn: readonly GoldenBody[],
): MappedRows {
  const jurisdictionIdBySlug = new Map<string, number>();
  const jurisdictions = jurisdictionsIn.map((j, i): JurisdictionInsert => {
    const id = i + 1;
    jurisdictionIdBySlug.set(j.slug, id);
    return {
      id,
      slug: j.slug,
      name: j.name,
      state: j.state,
    };
  });

  const bodyIdBySlug = new Map<string, number>();
  const bodies = bodiesIn.map((b, i): BodyInsert => {
    const id = i + 1;
    bodyIdBySlug.set(b.slug, id);
    const jurisdictionId = jurisdictionIdBySlug.get(b.jurisdiction_slug);
    if (jurisdictionId === undefined)
      throw new Error(
        `Body "${b.slug}" references unknown jurisdiction "${b.jurisdiction_slug}"`,
      );
    return {
      id,
      slug: b.slug,
      jurisdiction_id: jurisdictionId,
      name: b.name,
      name_short: b.name_short,
      timezone: b.timezone,
      meeting_source: b.meeting_source ?? null,
    };
  });

  return { jurisdictions, bodies, bodyIdBySlug };
}

/**
 * The database ids of a golden meeting's bodies, from their slugs.
 * Throws on one bodies.jsonl doesn't have.
 */
export function meetingBodyIds(
  meeting: Pick<GoldenMeeting, "slug" | "body_slugs">,
  bodyIdBySlug: ReadonlyMap<string, number>,
): number[] {
  return meeting.body_slugs.map((slug) => {
    const id = bodyIdBySlug.get(slug);
    if (id === undefined)
      throw new Error(`Meeting ${meeting.slug} has unknown body "${slug}"`);
    return id;
  });
}
