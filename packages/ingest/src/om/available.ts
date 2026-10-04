import { eq } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingsTable,
  videoSourcesTable,
} from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import type { VideoLister } from "@open-minutes/core/video-lister";
import { youtubeConfigFromEnv, youtubeSource } from "@open-minutes/youtube";

export type VideoSourceRow = typeof videoSourcesTable.$inferSelect;

export interface ListAvailableOptions {
  /** Restrict the scrape to the body with this slug (eg "gbos"). */
  body?: string;
  /**
   * The {@link VideoLister} for a `video_sources` row; injectable for tests.
   * Defaults to {@link defaultSourceFor}.
   */
  sourceFor?: (source: VideoSourceRow) => VideoLister;
}

/** Every video source is on YouTube, for now. */
export function defaultSourceFor(source: VideoSourceRow): VideoLister {
  return youtubeSource(
    { kind: source.kind, id: source.youtube_id },
    youtubeConfigFromEnv(),
  );
}

/**
 * Scrape every body's video sources and return the video IDs not yet
 * ingested, newest first (the source's natural order). A pure read: no database
 * writes, no persisted discovery state.
 */
export async function listAvailable(
  db: DB,
  options: ListAvailableOptions = {},
): Promise<string[]> {
  const sourceFor = options.sourceFor ?? defaultSourceFor;

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
      console.error(`Scraping ${body.name_short} ${source.url}...`);
      const videos = await sourceFor(source).listVideos();
      for (const video of videos) {
        if (!ingested.has(video.id)) available.push(video.id);
      }
    }
  }
  return available;
}
