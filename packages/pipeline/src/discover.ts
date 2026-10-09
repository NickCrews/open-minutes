import { type DB, bodiesTable, meetingsTable } from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import {
  type MeetingSource,
  meetingSourceUrl,
  siteKindOf,
} from "@open-minutes/core/meeting-source";
import type { VideoLister } from "@open-minutes/core/video-lister";
import { listerFor, type SiteMeeting } from "./sites";

export interface DiscoverOptions {
  /** Restrict the scan to the body with this slug (eg "gbos"). */
  body?: string;
  /**
   * The {@link VideoLister} for a body's meeting source; injectable for tests.
   * Defaults to {@link listerFor}.
   */
  sourceFor?: (source: MeetingSource) => VideoLister;
}

/** A meeting on a body's meeting source that isn't in the database yet. */
export interface DiscoveredMeeting extends SiteMeeting {
  /** The slug of the body whose source lists it, eg "gbos". */
  body: string;
}

/**
 * Scan every body's meeting source and return the meetings not in the
 * database, each body's newest first (the source's natural order). A pure
 * read: no database writes, no persisted discovery state.
 */
export async function discoverMeetings(
  db: DB,
  options: DiscoverOptions = {},
): Promise<DiscoveredMeeting[]> {
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

  const key = (siteKind: string, siteId: string) => `${siteKind} ${siteId}`;
  const known = new Set(
    (
      await db
        .select({
          siteKind: meetingsTable.site_kind,
          siteId: meetingsTable.site_id,
        })
        .from(meetingsTable)
    ).map((r) => key(r.siteKind, r.siteId)),
  );

  const discovered: DiscoveredMeeting[] = [];
  for (const body of bodies) {
    const source = body.meeting_source;
    if (!source) continue;
    const siteKind = siteKindOf(source);
    console.error(`Scanning ${body.name_short} ${meetingSourceUrl(source)}...`);
    const meetings = await sourceFor(source).listVideos();
    for (const { id } of meetings) {
      if (!known.has(key(siteKind, id)))
        discovered.push({ siteKind, siteId: id, body: bodySlug(body) });
    }
  }
  return discovered;
}
