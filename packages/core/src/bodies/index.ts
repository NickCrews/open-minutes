import { DB, bodiesTable, jurisdictionsTable, videoSourcesTable } from "../db";
import { eq, InferInsertModel } from "drizzle-orm";

type Jurisdiction = InferInsertModel<typeof jurisdictionsTable>;
type Body = InferInsertModel<typeof bodiesTable>;

/**
 * Short identifier for a body (eg "gbos"), used for `--body` CLI filters and
 * per-meeting work-directory names like `gbos_9HoIM5INxpI`.
 */
export function bodySlug(body: { name_short: string }): string {
  return body.name_short.toLowerCase();
}

export const MOA_JURISDICTION = {
  name: "Municipality of Anchorage",
  name_short: "MOA",
  state: "AK",
} as const satisfies Jurisdiction;

export const GBOS_BODY = {
  name: "Girdwood Board of Supervisors",
  name_short: "GBOS",
} as const satisfies Omit<Body, "jurisdiction_id">;

// https://www.youtube.com/channel/UCOUlNInprZEjhbpVPiJOlEA
export const GBOS_YOUTUBE_CHANNEL_ID = "UCOUlNInprZEjhbpVPiJOlEA";

/**
 * The GBOS body, creating it (and the MOA jurisdiction it sits inside) if this
 * database has not seen it yet. Keyed off the YouTube channel id rather than the
 * name, since that is the identifier ingestion actually arrives with.
 */
export async function getOrCreateGbos(db: DB) {
  const [existing] = await db
    .select({ id: bodiesTable.id })
    .from(bodiesTable)
    .innerJoin(videoSourcesTable, eq(videoSourcesTable.body_id, bodiesTable.id))
    .where(eq(videoSourcesTable.youtube_id, GBOS_YOUTUBE_CHANNEL_ID))
    .limit(1);
  if (existing) return { id: existing.id, ...GBOS_BODY };

  return await db.transaction(async (tx) => {
    const [jurisdiction] = await tx
      .select({ id: jurisdictionsTable.id })
      .from(jurisdictionsTable)
      .where(eq(jurisdictionsTable.name_short, MOA_JURISDICTION.name_short))
      .limit(1);
    const jurisdictionId =
      jurisdiction?.id ??
      (
        await tx
          .insert(jurisdictionsTable)
          .values(MOA_JURISDICTION)
          .returning({ id: jurisdictionsTable.id })
      )[0]!.id;

    const [created] = await tx
      .insert(bodiesTable)
      .values({ ...GBOS_BODY, jurisdiction_id: jurisdictionId })
      .returning({ id: bodiesTable.id });
    await tx.insert(videoSourcesTable).values({
      body_id: created!.id,
      kind: "channel",
      youtube_id: GBOS_YOUTUBE_CHANNEL_ID,
    });
    return { id: created!.id, ...GBOS_BODY };
  });
}
