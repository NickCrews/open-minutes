import type { RecordingMetadata } from "@open-minutes/core/site-adapter";

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
}

/**
 * The {@link RecordingMetadata} in a video's yt-dlp info JSON. It was
 * published when its stream or premiere started, else when it was uploaded.
 */
export function metadataFromYtDlpInfo(raw: YtDlpInfo): RecordingMetadata {
  const publishedSecs = raw.release_timestamp ?? raw.timestamp;
  return {
    id: raw.id,
    permalink: raw.webpage_url ?? videoUrl(raw.id),
    channelId: raw.channel_id ?? "",
    title: raw.title ?? "",
    description: raw.description ?? "",
    durationSecs: raw.duration ?? null,
    publishedAt: publishedSecs == null ? null : new Date(publishedSecs * 1000),
  };
}

/**
 * `metadata` as JSON, the way the blob store and the fetch-youtube-audio
 * workflow keep it: `publishedAt` is an ISO 8601 string.
 */
export function metadataToJson(
  metadata: RecordingMetadata,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`);
}

/** The {@link RecordingMetadata} in JSON from {@link metadataToJson}. */
export function metadataFromJson(json: Uint8Array): RecordingMetadata {
  const raw = JSON.parse(new TextDecoder().decode(json)) as Omit<
    RecordingMetadata,
    "publishedAt"
  > & { publishedAt: string | null };
  return {
    ...raw,
    publishedAt: raw.publishedAt === null ? null : new Date(raw.publishedAt),
  };
}
