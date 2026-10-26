/**
 * Where a body's meetings are published: `bodies.meeting_source`. A body has
 * at most one. A body that shares a YouTube channel with its siblings (the
 * Assembly, P&Z and the school board all publish to the MOA channel) gets its
 * own playlist on it instead.
 *
 * Stored as JSON, so adding a kind means a new member here, a case in the
 * `bodies_meeting_source_valid` check (see the db schema), and a scout for it.
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
