import { eq } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  meetingsTable,
  videoSourcesTable,
} from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import { type FlatEntry, type YouTube, youtubeFromEnv } from "../youtube";

export interface ListAvailableOptions {
  /** Restrict the scrape to the body with this slug (eg "gbos"). */
  body?: string;
  /** YouTube boundary, injectable for tests. Defaults to {@link youtubeFromEnv}. */
  yt?: YouTube;
}

/** A video on a body's video source that isn't a meeting in the database. */
export interface AvailableVideo {
  youtubeId: string;
  /** The body whose video source it was found under. */
  bodyId: number;
  /** That body's slug (eg "gbos"). */
  body: string;
  /** What the channel or playlist listing says about it. */
  entry: FlatEntry;
}

/**
 * Scrape every body's YouTube sources and return the videos not yet in the
 * database, newest first (the source's natural order). Each is attributed to
 * the body whose source listed it; a video listed by several sources goes to
 * the first. A pure read: no database writes.
 */
export async function scrapeAvailable(
  db: DB,
  options: ListAvailableOptions = {},
): Promise<AvailableVideo[]> {
  const yt = options.yt ?? youtubeFromEnv();

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

  const known = new Set(
    (
      await db
        .select({ youtubeId: meetingsTable.youtube_id })
        .from(meetingsTable)
    ).map((r) => r.youtubeId),
  );

  const available: AvailableVideo[] = [];
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
      for (const entry of videos) {
        if (known.has(entry.id)) continue;
        known.add(entry.id);
        available.push({
          youtubeId: entry.id,
          bodyId: body.id,
          body: bodySlug(body),
          entry,
        });
      }
    }
  }
  return available;
}

/**
 * The IDs of the videos on bodies' sources that aren't meetings in the
 * database yet, newest first. See {@link scrapeAvailable}.
 */
export async function listAvailable(
  db: DB,
  options: ListAvailableOptions = {},
): Promise<string[]> {
  return (await scrapeAvailable(db, options)).map((v) => v.youtubeId);
}
