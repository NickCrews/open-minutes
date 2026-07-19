import { eq } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingsTable,
  videoSourcesTable,
} from "@open-minutes/core/db";
import { bodySlug } from "@open-minutes/core/bodies";
import { realYouTube, type YouTube } from "@open-minutes/core/youtube";

export interface ListAvailableOptions {
  /** Restrict the scrape to the body with this slug (eg "gbos"). */
  body?: string;
  /** YouTube boundary, injectable for tests. Defaults to the real yt-dlp one. */
  yt?: YouTube;
}

/**
 * Scrape every body's YouTube sources and return the video IDs not yet
 * ingested, newest first (the source's natural order). A pure read: no database
 * writes, no persisted discovery state.
 */
export async function listAvailable(
  db: DB,
  options: ListAvailableOptions = {},
): Promise<string[]> {
  const yt = options.yt ?? realYouTube;

  const allBodies = await db.select().from(bodiesTable);
  let bodies = allBodies;
  if (options.body !== undefined) {
    const wanted = options.body.toLowerCase();
    bodies = bodies.filter((b) => bodySlug(b) === wanted);
    if (bodies.length === 0) {
      const known = allBodies.map(bodySlug).sort().join(", ");
      throw new Error(`No body with slug "${options.body}". Known: ${known}`);
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
  for (const body of bodies) {
    const sources = await db
      .select()
      .from(videoSourcesTable)
      .where(eq(videoSourcesTable.body_id, body.id));
    for (const source of sources) {
      console.error(
        `Scraping ${body.name_short} ${source.kind} ${source.youtube_id}...`,
      );
      const videos =
        source.kind === "playlist"
          ? await yt.videosInPlaylist(source.youtube_id)
          : await yt.videosInChannel(source.youtube_id);
      for (const video of videos) {
        if (!ingested.has(video.id)) available.push(video.id);
      }
    }
  }
  return available;
}
