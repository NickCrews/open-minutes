import type { RecordingMetadata } from "@open-minutes/core/site";

/** The 11-character video ID, from either an ID or a watch/youtu.be URL. */
export function videoId(videoIdOrUrl: string): string {
  if (/^[A-Za-z0-9_-]{11}$/.test(videoIdOrUrl)) return videoIdOrUrl;
  const url = new URL(videoIdOrUrl);
  const id =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : url.searchParams.get("v");
  if (!id) throw new Error(`No YouTube video ID in ${videoIdOrUrl}`);
  return id;
}

/** A youtube.com URL as-is, else the watch URL of a video ID. */
export function videoUrl(videoIdOrUrl: string): string {
  if (videoIdOrUrl.includes("youtube.com")) return videoIdOrUrl;
  return `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
}

/** The fields of yt-dlp's info JSON (`-J`) that the pipeline uses. */
export interface YtDlpInfo {
  id: string;
  channel_id?: string;
  title?: string;
  description?: string;
  duration?: number | null;
  /** When it was uploaded, in seconds since the epoch. */
  timestamp?: number | null;
  /** When a stream or premiere started, in seconds since the epoch. */
  release_timestamp?: number | null;
  webpage_url?: string;
  /**
   * `is_upcoming`, `is_live` or `post_live` while a stream or premiere has no
   * complete recording yet; `was_live` or `not_live` once it has.
   */
  live_status?: string | null;
}

/** Live statuses whose video doesn't yet hold its whole recording. */
const UNFINISHED_LIVE_STATUSES = new Set([
  "is_upcoming",
  "is_live",
  "post_live",
]);

/**
 * Whether yt-dlp's stderr says the video is a stream or premiere that hasn't
 * started, so it has no formats yet (eg "This live event will begin in 91
 * minutes.", "Premieres in 2 hours").
 */
export function isNotStartedYet(stderr: string): boolean {
  return /live event will begin|Premieres in/i.test(stderr);
}

/**
 * The {@link RecordingMetadata} in a video's yt-dlp info JSON. It was
 * published when its stream or premiere started, else when it was uploaded.
 * A stream or premiere that hasn't finished has no duration.
 */
export function metadataFromYtDlpInfo(raw: YtDlpInfo): RecordingMetadata {
  const publishedSecs = raw.release_timestamp ?? raw.timestamp;
  return {
    id: raw.id,
    permalink: raw.webpage_url ?? videoUrl(raw.id),
    channelId: raw.channel_id ?? "",
    title: raw.title ?? "",
    description: raw.description ?? "",
    durationSecs: UNFINISHED_LIVE_STATUSES.has(raw.live_status ?? "")
      ? null
      : (raw.duration ?? null),
    publishedAt: publishedSecs == null ? null : new Date(publishedSecs * 1000),
  };
}
