import { sql } from "drizzle-orm";
import { type DB, meetingsTable } from "@open-minutes/db";
import { parseDateFromTitle } from "../meeting_date";
import type { FlatEntry } from "../youtube";
import { type ListAvailableOptions, scrapeAvailable } from "./available";

/** A meeting {@link discoverMeetings} recorded. */
export interface DiscoveredMeeting {
  youtubeId: string;
  meetingId: number;
  /** Body slug (eg "gbos"). */
  body: string;
  title: string;
  /** "YYYY-MM-DD" read from the title, or null. */
  date: string | null;
}

/**
 * Scrape every body's video sources and record each video that isn't a
 * meeting yet as one, attributed to the body whose source listed it. Returns
 * the meetings recorded, newest first.
 *
 * A discovered meeting has only what the listing says (title, duration) and
 * the date its title states, if any. It has no transcript: its processing
 * steps are pending, for `processMeeting` to pick up, which also refreshes
 * its metadata from the video itself. Recording it is cheap and needs nothing
 * from YouTube but the listing, which works from datacenter IPs.
 */
export async function discoverMeetings(
  db: DB,
  options: ListAvailableOptions = {},
): Promise<DiscoveredMeeting[]> {
  const available = await scrapeAvailable(db, options);
  const discovered: DiscoveredMeeting[] = [];
  for (const video of available) {
    const title = video.entry.title ?? "";
    const date =
      parseDateFromTitle(title, { uploadDate: uploadDate(video.entry) })
        ?.date ?? null;
    const duration = video.entry.duration;
    // ON CONFLICT: a concurrent discovery (or ingest) may have just recorded
    // it; then there's nothing to do.
    const [row] = await db
      .insert(meetingsTable)
      .values({
        body_id: video.bodyId,
        youtube_id: video.youtubeId,
        title,
        date,
        duration_secs:
          typeof duration === "number"
            ? sql`make_interval(secs => ${duration})`
            : null,
      })
      .onConflictDoNothing({ target: meetingsTable.youtube_id })
      .returning({ id: meetingsTable.id });
    if (!row) continue;
    console.error(
      `[${video.youtubeId}] discovered for ${video.body}: ${title || "(untitled)"}`,
    );
    discovered.push({
      youtubeId: video.youtubeId,
      meetingId: row.id,
      body: video.body,
      title,
      date,
    });
  }
  return discovered;
}

/** The listing's publish day as "YYYY-MM-DD" (UTC), if it gives one. */
function uploadDate(entry: FlatEntry): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(entry.upload_date ?? "");
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (typeof entry.timestamp === "number") {
    return new Date(entry.timestamp * 1000).toISOString().slice(0, 10);
  }
  return undefined;
}
