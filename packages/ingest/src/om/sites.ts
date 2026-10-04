import type { AudioProvider } from "@open-minutes/core/audio-provider";
import type { MeetingSource, Site } from "@open-minutes/core/meeting-source";
import type { VideoLister } from "@open-minutes/core/video-lister";
import { akleg, aklegSource, parseMeetingId } from "@open-minutes/akleg";
import { videoId, youtubeFromEnv, youtubeSource } from "@open-minutes/youtube";

/** Each site's {@link AudioProvider}: where a meeting's metadata and audio come from. */
export type Sites = Record<Site, AudioProvider>;

/**
 * `sites`, with each one missing filled in from the environment. Each is
 * created only when first used, so a test that passes the one it needs never
 * reaches for the others.
 */
export function withDefaultSites(sites: Partial<Sites> = {}): Sites {
  let youtube = sites.youtube;
  let aklegSite = sites.akleg;
  return {
    get youtube() {
      return (youtube ??= youtubeFromEnv());
    },
    get akleg() {
      return (aklegSite ??= akleg());
    },
  };
}

/** The {@link VideoLister} for a body's meeting source. */
export function listerFor(source: MeetingSource): VideoLister {
  switch (source.type) {
    case "youtube_channel":
      return youtubeSource({ kind: "channel", id: source.channel_id });
    case "youtube_playlist":
      return youtubeSource({ kind: "playlist", id: source.playlist_id });
    case "akleg_committee":
      return aklegSource({ committee: source.committee });
  }
}

/** A meeting on its site: see `meetings.site` and `meetings.site_id`. */
export interface SiteMeeting {
  site: Site;
  siteId: string;
}

/**
 * The meeting `ref` names: an akleg.gov meeting ID or page URL ("HRES
 * 2018-09-10 14:00:00"), else a YouTube video ID or URL.
 */
export function parseMeetingRef(ref: string): SiteMeeting {
  const aklegId = parseMeetingId(ref);
  if (aklegId) return { site: "akleg", siteId: aklegId };
  return {
    site: "youtube",
    siteId: /^https?:\/\//.test(ref) ? videoId(ref) : ref,
  };
}

/**
 * The name of a meeting's work directory under the work root: its body's slug
 * and its ID, with anything but letters, digits, `-` and `_` (an akleg.gov
 * ID's spaces and colons) replaced by `-`.
 */
export function workDirName(bodySlug: string, siteId: string): string {
  return `${bodySlug}_${siteId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}
