import { type DB, bodiesTable, meetingsTable } from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import {
  type MeetingSource,
  meetingSourceUrl,
  siteOf,
} from "@open-minutes/core/meeting-source";
import type { VideoLister } from "@open-minutes/core/video-lister";
import { listerFor, type SiteMeeting } from "./sites";

export interface ListAvailableOptions {
  /** Restrict the scrape to the body with this slug (eg "gbos"). */
  body?: string;
  /**
   * The {@link VideoLister} for a body's meeting source; injectable for tests.
   * Defaults to {@link listerFor}.
   */
  sourceFor?: (source: MeetingSource) => VideoLister;
}

/** A meeting on a body's meeting source that isn't in the database yet. */
export interface AvailableMeeting extends SiteMeeting {
  /** The slug of the body whose source lists it, eg "gbos". */
  body: string;
}

/**
 * Scrape every body's meeting source and return the meetings not yet
 * ingested, each body's newest first (the source's natural order). A pure
 * read: no database writes, no persisted discovery state.
 */
export async function listAvailable(
  db: DB,
  options: ListAvailableOptions = {},
): Promise<AvailableMeeting[]> {
  const sourceFor = options.sourceFor ?? listerFor;

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

  const key = (site: string, siteId: string) => `${site} ${siteId}`;
  const ingested = new Set(
    (
      await db
        .select({ site: meetingsTable.site, siteId: meetingsTable.site_id })
        .from(meetingsTable)
    ).map((r) => key(r.site, r.siteId)),
  );

  const available: AvailableMeeting[] = [];
  for (const body of bodies) {
    const source = body.meeting_source;
    if (!source) continue;
    const site = siteOf(source);
    console.error(`Scraping ${body.name_short} ${meetingSourceUrl(source)}...`);
    const meetings = await sourceFor(source).listVideos();
    for (const { id } of meetings) {
      if (!ingested.has(key(site, id)))
        available.push({ site, siteId: id, body: bodySlug(body) });
    }
  }
  return available;
}
