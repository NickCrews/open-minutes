import { DB, municipalitiesTable } from "../db";
import { eq, InferInsertModel } from "drizzle-orm";

type Municipality = InferInsertModel<typeof municipalitiesTable>;

/**
 * Short identifier for a municipality (eg "gbos"), used for `--muni` CLI
 * filters and per-meeting work-directory names like `gbos_9HoIM5INxpI`.
 */
export function muniSlug(muni: { name_short: string }): string {
  return muni.name_short.toLowerCase();
}

export const GBOS_MUNICIPALITY = {
  name: "Girdwood Board of Supervisors",
  name_short: "GBOS",
  state: "AK",
  // https://www.youtube.com/channel/UCOUlNInprZEjhbpVPiJOlEA
  youtube_channel_id: "UCOUlNInprZEjhbpVPiJOlEA",
} as const satisfies Municipality;

export const MOA_MUNICIPALITY = {
  name: "Municipality of Anchorage",
  name_short: "MOA",
  state: "AK",
  // https://www.youtube.com/channel/UCZDEuWj4IxdlwBhqrk62_XA
  youtube_channel_id: "UCZDEuWj4IxdlwBhqrk62_XA",
} as const satisfies Municipality;

export async function getOrCreateGbos(db: DB) {
  const [existing] = await db
    .select({ id: municipalitiesTable.id })
    .from(municipalitiesTable)
    .where(
      eq(
        municipalitiesTable.youtube_channel_id,
        GBOS_MUNICIPALITY.youtube_channel_id,
      ),
    )
    .limit(1);
  if (existing) return { id: existing.id, ...GBOS_MUNICIPALITY };

  const [created] = await db
    .insert(municipalitiesTable)
    .values(GBOS_MUNICIPALITY)
    .returning({ id: municipalitiesTable.id });
  return { id: created!.id, ...GBOS_MUNICIPALITY };
}
