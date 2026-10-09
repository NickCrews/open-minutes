/**
 * Where a body's meetings are published, which discovery scans for new
 * ones: `bodies.meeting_source`. A body has at most one. A body that shares a
 * YouTube channel with its siblings (the Assembly, P&Z and the school board all
 * publish to the MOA channel) gets its own playlist on it instead.
 *
 * Stored as JSON, so adding a kind means a new member here, a case in the
 * `bodies_meeting_source_valid` check (see the db schema), and a lister in the
 * pipeline.
 */
export type MeetingSource =
  | {
      type: "youtube_channel";
      /** "UC..." */
      channel_id: string;
    }
  | {
      type: "youtube_playlist";
      /** "PL..." */
      playlist_id: string;
    }
  | {
      /** A committee of the Alaska Legislature, on akleg.gov. */
      type: "akleg_committee";
      /** Its chamber and code, as in akleg.gov meeting IDs: "HRES". */
      committee: string;
    };

/**
 * Which site a meeting is published on: `meetings.site_kind`. A meeting's ID
 * on its site (`meetings.site_id`) is a YouTube video ID, or an akleg.gov
 * meeting ID ("HRES 2018-09-10 14:00:00").
 */
export type SiteKind = "youtube" | "akleg";

export const SITE_KINDS: readonly SiteKind[] = ["youtube", "akleg"];

/** The kind of site a source's meetings are on. */
export function siteKindOf(source: MeetingSource): SiteKind {
  switch (source.type) {
    case "youtube_channel":
    case "youtube_playlist":
      return "youtube";
    case "akleg_committee":
      return "akleg";
  }
}

/**
 * The source's page, for people. An akleg.gov committee's is its page for the
 * Legislature sitting in `year` (by default, this one).
 */
export function meetingSourceUrl(
  source: MeetingSource,
  year = new Date().getFullYear(),
): string {
  switch (source.type) {
    case "youtube_channel":
      return `https://www.youtube.com/channel/${source.channel_id}`;
    case "youtube_playlist":
      return `https://www.youtube.com/playlist?list=${source.playlist_id}`;
    case "akleg_committee": {
      // The Legislature sits for two years, the 30th in 2017-2018.
      const legislature = Math.floor((year - 1957) / 2);
      return `https://www.akleg.gov/basis/Committee/Details/${legislature}?code=${encodeURIComponent(source.committee)}`;
    }
  }
}

/** How the source is labeled in a link to it: "YouTube channel". */
export function meetingSourceLabel(source: MeetingSource): string {
  switch (source.type) {
    case "youtube_channel":
      return "YouTube channel";
    case "youtube_playlist":
      return "YouTube playlist";
    case "akleg_committee":
      return "akleg.gov committee";
  }
}

/**
 * The meeting's YouTube video ID, or null when it isn't on YouTube. For
 * what only works with YouTube: its player and thumbnails.
 */
export function youtubeIdOf(meeting: {
  site_kind: string;
  site_id: string;
}): string | null {
  return meeting.site_kind === "youtube" ? meeting.site_id : null;
}
