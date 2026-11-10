import type { MeetingSource } from "@open-minutes/core/meeting-source";
import type {
  RecordingLister,
  Site,
  SiteAdapter,
} from "@open-minutes/core/site";
import { akleg, aklegSource } from "@open-minutes/akleg";
import {
  type YouTube,
  type YouTubeOptions,
  youtube,
  youtubeSource,
} from "@open-minutes/youtube";

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
 * The adapter that reaches each site itself. `youtube` is passed to
 * `youtube()`: an adapter, or its options.
 */
export function siteAdapters({
  youtube: yt,
}: { youtube?: YouTube | YouTubeOptions } = {}): Record<Site, SiteAdapter> {
  return {
    youtube: youtube(yt),
    akleg: akleg(),
  };
}
