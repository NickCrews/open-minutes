import { mkdir, access, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AudioProvider,
  RecordingMetadata,
} from "@open-minutes/core/audio-provider";
import type {
  ListedRecording,
  RecordingLister,
} from "@open-minutes/core/recording-lister";
import type { FetchAudio } from "@open-minutes/core/scout";
import {
  type Egress,
  type Route,
  ensureYtDlpInstalled,
  parseRoutes,
  run,
  runWithEgress,
} from "@open-minutes/ytdlp";
/**
 * A channel (all its videos) or one playlist, as a body's meeting source.
 * Bodies that share a channel with their siblings (the Assembly, P&Z and the
 * school board all publish to the MOA channel) each get a playlist on it.
 */
export interface YouTubeSource {
  kind: "channel" | "playlist";
  /** A channel ID (UC...) or playlist ID (PL...), per `kind`. */
  id: string;
}

/** The URL of a {@link YouTubeSource}. */
export function sourceUrl({ kind, id }: YouTubeSource): string {
  return kind === "channel"
    ? `https://www.youtube.com/channel/${id}`
    : `https://www.youtube.com/playlist?list=${id}`;
}

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

function videoUrl(videoIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (videoIdOrUrl.includes("youtube.com")) {
    return videoIdOrUrl;
  }
  return `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
}

/** How to reach YouTube. See {@link youtubeConfigFromEnv} for where each comes from. */
export interface YouTubeConfig {
  /**
   * The routes yt-dlp tries for a video's metadata and audio (see
   * `runWithEgress` in `@open-minutes/ytdlp`; by default `YOUTUBE_EGRESS`,
   * else direct, then WARP, then Tor).
   */
  routes?: Route[];
}

/**
 * Runs yt-dlp through `config`'s routes, installing yt-dlp first if it's
 * missing.
 */
async function ytDlpWithEgress(
  config: YouTubeConfig,
  args: string[],
  beforeAttempt?: () => Promise<void>,
) {
  await ensureYtDlpInstalled();
  return runWithEgress(args, { routes: config.routes, beforeAttempt });
}

interface FlatEntry {
  /** "url" for a video, "playlist" for a nested tab/playlist. */
  _type?: "url" | "playlist";
  id: string;
  title?: string;
  entries?: FlatEntry[];
}

/**
 * Pull the videos out of a yt-dlp `--flat-playlist` tree. A channel URL expands
 * into one nested playlist per tab ("Videos", "Live", ...), so the top-level
 * entries are playlists, not videos — walk down to the `_type: "url"` leaves.
 * Deduped by ID, since a video can appear under more than one tab.
 */
function flattenVideos(node: FlatEntry, seen = new Set<string>()): FlatEntry[] {
  if (node.entries) return node.entries.flatMap((e) => flattenVideos(e, seen));
  // A leaf without _type is still a video: older yt-dlp output omits it.
  if (node._type !== undefined && node._type !== "url") return [];
  if (seen.has(node.id)) return [];
  seen.add(node.id);
  return [node];
}

/**
 * The videos in a channel or playlist. A channel's span all its tabs
 * ("Videos", "Live", ...).
 */
async function listVideos(source: YouTubeSource): Promise<ListedRecording[]> {
  // Listing works from any IP, so it needs no egress.
  await ensureYtDlpInstalled();
  const { stdout } = await run(["--flat-playlist", "-J", sourceUrl(source)]);
  return flattenVideos(JSON.parse(stdout) as FlatEntry).map(
    ({ id, title }) => ({ id, title }),
  );
}

/** The fields of yt-dlp's info JSON (`-J`) that the pipeline uses. */
export interface YtDlpInfo {
  id: string;
  channel_id?: string;
  title?: string;
  description?: string;
  duration?: number | null;
  /** "YYYYMMDD". */
  upload_date?: string | null;
  /** When it was uploaded, in seconds since the epoch. */
  timestamp?: number | null;
  /** When a stream or premiere started, in seconds since the epoch. */
  release_timestamp?: number | null;
  /** Whether it is or was a stream; absent for some videos. */
  live_status?:
    | "not_live"
    | "is_live"
    | "is_upcoming"
    | "was_live"
    | "post_live"
    | null;
  webpage_url?: string;
}

/**
 * When YouTube published the video: a stream's or premiere's start, otherwise
 * its upload; null when yt-dlp gives neither.
 */
export function publishedAt(info: YtDlpInfo): Date | null {
  const secs = info.release_timestamp ?? info.timestamp;
  return secs == null ? null : new Date(secs * 1000);
}

/**
 * Whether the video's audio is all there: false for a stream that is live or
 * upcoming, or that has just ended and YouTube is still processing.
 */
export function isComplete(info: YtDlpInfo): boolean {
  return (
    info.live_status !== "is_live" &&
    info.live_status !== "is_upcoming" &&
    info.live_status !== "post_live"
  );
}

/**
 * A video's yt-dlp info JSON, through `egress`, which keeps WARP and Tor up
 * between calls; for a scout's many.
 */
export async function videoInfo(
  egress: Egress,
  videoIdOrUrl: string,
): Promise<YtDlpInfo> {
  await ensureYtDlpInstalled();
  const { stdout } = await egress.run([
    "--skip-download",
    "-J",
    videoUrl(videoIdOrUrl),
  ]);
  return JSON.parse(stdout) as YtDlpInfo;
}

/** The videos in a channel or playlist, as {@link youtubeSource} lists them. */
export function listVideosIn(
  source: YouTubeSource,
): Promise<ListedRecording[]> {
  return listVideos(source);
}

/** The {@link RecordingMetadata} in a video's yt-dlp info JSON. */
export function metadataFromYtDlpInfo(raw: YtDlpInfo): RecordingMetadata {
  return {
    id: raw.id,
    channelId: raw.channel_id ?? "",
    title: raw.title ?? "",
    description: raw.description ?? "",
    durationSecs: raw.duration ?? null,
    uploadDate: isoDate(raw.upload_date),
  };
}

async function getMetadata(
  config: YouTubeConfig,
  videoIdOrUrl: string,
): Promise<RecordingMetadata> {
  const { stdout } = await ytDlpWithEgress(config, [
    "--skip-download",
    "-J",
    videoUrl(videoIdOrUrl),
  ]);
  return metadataFromYtDlpInfo(JSON.parse(stdout) as YtDlpInfo);
}

/** yt-dlp's "YYYYMMDD" as "YYYY-MM-DD"; null if absent or malformed. */
function isoDate(yyyymmdd: string | null | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Downloads a video's audio in yt-dlp `format` to `path`. A single format
 * needs no ffmpeg to download.
 */
async function downloadAudio(
  config: YouTubeConfig,
  videoIdOrUrl: string,
  path: string,
  format: string,
) {
  await mkdir(dirname(path), { recursive: true });
  const url = videoUrl(videoIdOrUrl);
  // Downloaded beside `path` and moved into place, so an interrupted download
  // never leaves a partial file at `path`.
  const webm = `${path}.download.webm`;
  const removeWebm = async () => {
    await rm(webm, { force: true });
    await rm(`${webm}.part`, { force: true });
  };
  try {
    await ytDlpWithEgress(
      config,
      ["-f", format, "--no-playlist", "-o", webm, url],
      removeWebm,
    );
    await rename(webm, path);
  } finally {
    await removeWebm();
  }
}

/**
 * Downloads a video's original Opus-in-WebM audio to `path`, keeping an
 * existing file there unless `overwrite` is set.
 */
async function ensureAudioDownloaded(
  config: YouTubeConfig,
  videoIdOrUrl: string,
  path: string,
  { overwrite = false }: { overwrite?: boolean } = {},
) {
  await mkdir(dirname(path), { recursive: true });
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !overwrite) return { downloaded: false };

  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(
    `Downloading audio for ${videoUrl(videoIdOrUrl)} to ${path}...`,
  );
  // The format the fetch-youtube-audio workflow re-encodes from.
  await downloadAudio(config, videoIdOrUrl, path, "bestaudio[ext=webm]");
  return { downloaded: true };
}

/**
 * YouTube's {@link FetchAudio}, using `config`: its Opus stream (format 251),
 * else its best audio.
 */
export function youtubeFetchAudio(config: YouTubeConfig = {}): FetchAudio {
  return async (videoId, dest, signal) => {
    signal.throwIfAborted();
    await downloadAudio(config, videoId, dest, "251/bestaudio");
  };
}

/**
 * A video's metadata and audio from YouTube (via yt-dlp). Create one with
 * {@link youtube} or {@link youtubeFromEnv} and pass it around; tests pass a
 * fake instead (see the pipeline's `om/testing.ts`).
 */
export type YouTube = AudioProvider & {
  readonly audioExtension: "webm";
};

/**
 * Lists the videos in `source` (via yt-dlp, always direct: listing works from
 * datacenter IPs). Does no I/O until
 * {@link RecordingLister.listRecordings} is called.
 */
export function youtubeSource(source: YouTubeSource): RecordingLister {
  return { listRecordings: () => listVideos(source) };
}

/** A {@link YouTube} that uses `config`. Does no I/O until a method is called. */
export function youtube(config: YouTubeConfig = {}): YouTube {
  return {
    audioExtension: "webm",
    getMetadata: (videoIdOrUrl) => getMetadata(config, videoIdOrUrl),
    ensureAudioDownloaded: (videoIdOrUrl, path, options) =>
      ensureAudioDownloaded(config, videoIdOrUrl, path, options),
  };
}

/**
 * A {@link YouTubeConfig} from environment variables:
 * - YOUTUBE_EGRESS: {@link YouTubeConfig.routes}, comma-separated
 */
export function youtubeConfigFromEnv(env = process.env): YouTubeConfig {
  const routes = parseRoutes(env.YOUTUBE_EGRESS ?? "");
  return { routes: routes.length ? routes : undefined };
}

/** A {@link YouTube} configured by {@link youtubeConfigFromEnv}. */
export function youtubeFromEnv(env = process.env): YouTube {
  return youtube(youtubeConfigFromEnv(env));
}
