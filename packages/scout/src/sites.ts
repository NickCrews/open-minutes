import type { MeetingSource } from "@open-minutes/core/meeting-source";
import type {
  RecordingLister,
  Site,
  SiteAdapter,
} from "@open-minutes/core/site";
import { akleg, aklegSource } from "@open-minutes/akleg";
import { youtube, youtubeSource } from "@open-minutes/youtube";

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
 * The adapter that reaches each site itself. With `debs`, YouTube's installs
 * WARP and Tor (keeping their .deb files there) when YouTube refuses a direct
 * request.
 */
export function siteAdapters({ debs }: { debs?: string } = {}): Record<
  Site,
  SiteAdapter
> {
  return {
    youtube: youtube(debs ? { installEgress: { debDir: debs } } : {}),
    akleg: akleg(),
  };
}
