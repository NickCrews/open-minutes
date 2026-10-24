import { asc, eq } from "drizzle-orm";
import {
  bodiesTable,
  jurisdictionsTable,
  meetingBodiesTable,
} from "@open-minutes/db";
import { type GlossaryBody } from "@open-minutes/glossary";
import type { Db } from "./tool";

/** The bodies that held a meeting, as glossaries pick their bodies. */
export async function glossaryBodies(
  db: Db,
  meetingId: number,
): Promise<GlossaryBody[]> {
  return db
    .select({
      slug: bodiesTable.slug,
      jurisdictionSlug: jurisdictionsTable.slug,
    })
    .from(meetingBodiesTable)
    .innerJoin(bodiesTable, eq(bodiesTable.id, meetingBodiesTable.body_id))
    .innerJoin(
      jurisdictionsTable,
      eq(jurisdictionsTable.id, bodiesTable.jurisdiction_id),
    )
    .where(eq(meetingBodiesTable.meeting_id, meetingId))
    .orderBy(asc(bodiesTable.slug));
}
