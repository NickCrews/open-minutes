import {
  type DB,
  meetingsTable,
  municipalitiesTable,
} from "@open-minutes/core/db";
import { muniSlug } from "@open-minutes/core/munis";
import { realYouTube, type YouTube } from "@open-minutes/core/youtube";

export interface ListAvailableOptions {
  /** Restrict the scrape to the municipality with this slug (eg "gbos"). */
  muni?: string;
  /** YouTube boundary, injectable for tests. Defaults to the real yt-dlp one. */
  yt?: YouTube;
}

/**
 * Scrape each municipality's YouTube channel and return the video IDs not yet
 * ingested, newest first (the channel's natural order). A pure read: no
 * database writes, no persisted discovery state.
 */
export async function listAvailable(
  db: DB,
  options: ListAvailableOptions = {},
): Promise<string[]> {
  const yt = options.yt ?? realYouTube;

  const allMunis = await db.select().from(municipalitiesTable);
  let munis = allMunis.filter((m) => m.youtube_channel_id);
  if (options.muni !== undefined) {
    const wanted = options.muni.toLowerCase();
    munis = munis.filter((m) => muniSlug(m) === wanted);
    if (munis.length === 0) {
      const known = allMunis.map(muniSlug).sort().join(", ");
      throw new Error(
        `No municipality with slug "${options.muni}". Known: ${known}`,
      );
    }
  }

  const ingested = new Set(
    (
      await db
        .select({ youtubeId: meetingsTable.youtube_id })
        .from(meetingsTable)
    ).map((r) => r.youtubeId),
  );

  const available: string[] = [];
  for (const muni of munis) {
    console.error(
      `Scraping ${muni.name_short} channel ${muni.youtube_channel_id}...`,
    );
    const videos = await yt.videosInChannel(muni.youtube_channel_id!);
    for (const video of videos) {
      if (!ingested.has(video.id)) available.push(video.id);
    }
  }
  return available;
}
