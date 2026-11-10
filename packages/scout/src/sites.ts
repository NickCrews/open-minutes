import type { MeetingSource } from "@open-minutes/core/meeting-source";
import type {
  RecordingLister,
  Site,
  SiteAdapter,
} from "@open-minutes/core/site";
import { akleg, aklegSource } from "@open-minutes/akleg";
import { youtube, youtubeSource } from "@open-minutes/youtube";
import type { Egress, EgressOptions } from "@open-minutes/ytdlp";

/** The `RecordingLister` for a body's meeting source. */
export function listerFor(source: MeetingSource): RecordingLister {
  switch (source.type) {
    case "youtube_channel":
      return youtubeSource({ kind: "channel", id: source.channel_id });
    case "youtube_playlist":
      return youtubeSource({ kind: "playlist", id: source.playlist_id });
    case "akleg_committee":
      return aklegSource({ committee: source.committee });
  }
}

/**
 * The adapter that reaches each site itself. `egress` is YouTube's (see
 * `YouTubeOptions`): options for routes set up per request, or a manager
 * every request shares, which the caller closes.
 */
export function siteAdapters({
  egress,
}: { egress?: Egress | EgressOptions } = {}): Record<Site, SiteAdapter> {
  return {
    youtube: youtube({ egress }),
    akleg: akleg(),
  };
}
