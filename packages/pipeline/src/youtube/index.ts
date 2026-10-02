import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";
import type { AudioProvider, VideoMetadata } from "../audio-provider";

export type { AudioProvider, VideoMetadata } from "../audio-provider";

const execFileAsync = promisify(execFile);

function channelUrl(channelIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (channelIdOrUrl.includes("youtube.com")) {
    return channelIdOrUrl;
  }
  return `https://www.youtube.com/channel/${channelIdOrUrl}`;
}

function playlistUrl(playlistIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (playlistIdOrUrl.includes("youtube.com")) {
    return playlistIdOrUrl;
  }
  return `https://www.youtube.com/playlist?list=${playlistIdOrUrl}`;
}

function videoUrl(videoIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (videoIdOrUrl.includes("youtube.com")) {
    return videoIdOrUrl;
  }
  return `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
}

/** How to reach YouTube. See {@link youtubeFromEnv} for where each comes from. */
export interface YouTubeConfig {
  /**
   * A Netscape-format cookies.txt from a browser signed in to YouTube. YouTube
   * makes datacenter IPs (CI runners, servers) "sign in to confirm you're not a
   * bot", and these get past it. Anything else (a proxy, say) can go in
   * yt-dlp's own config file.
   */
  cookies?: string;
}

/** Runs yt-dlp with the options every call shares. */
function ytDlp(config: YouTubeConfig, args: string[]) {
  return execFileAsync(
    "yt-dlp",
    [...(config.cookies ? ["--cookies", config.cookies] : []), ...args],
    // A busy channel's flat playlist runs to several MB.
    { maxBuffer: 100 * 1024 * 1024 },
  );
}

export interface FlatEntry {
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

async function flatPlaylist(config: YouTubeConfig, url: string) {
  const { stdout } = await ytDlp(config, ["--flat-playlist", "-J", url]);
  return flattenVideos(JSON.parse(stdout) as FlatEntry);
}

async function getMetadata(
  config: YouTubeConfig,
  videoIdOrUrl: string,
): Promise<VideoMetadata> {
  const { stdout } = await ytDlp(config, [
    "--skip-download",
    "-J",
    videoUrl(videoIdOrUrl),
  ]);
  const raw = JSON.parse(stdout) as {
    id: string;
    channel_id?: string;
    title?: string;
    description?: string;
    duration?: number | null;
    /** "YYYYMMDD". */
    upload_date?: string | null;
  };
  return {
    id: raw.id,
    channelId: raw.channel_id ?? "",
    title: raw.title ?? "",
    description: raw.description ?? "",
    durationSecs: raw.duration ?? null,
    uploadDate: isoDate(raw.upload_date),
  };
}

/** yt-dlp's "YYYYMMDD" as "YYYY-MM-DD"; null if absent or malformed. */
function isoDate(yyyymmdd: string | null | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

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

  const url = videoUrl(videoIdOrUrl);
  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(`Downloading audio for ${url} to ${path}...`);
  await ytDlp(config, [
    "-x",
    "--audio-format",
    "wav",
    // the trancription model wants 16kHz audio with one channel
    "--postprocessor-args",
    "ffmpeg:-ar 16000 -ac 1",
    "--audio-quality",
    "0",
    "-o",
    path,
    url,
  ]);
  return { downloaded: true };
}

/**
 * Everything the pipeline gets from YouTube (via yt-dlp). Create one with
 * {@link youtube} or {@link youtubeFromEnv} and pass it around; tests pass a
 * fake instead (see `om/testing.ts`).
 */
export interface YouTube extends AudioProvider {
  /** The videos on a channel, across all its tabs ("Videos", "Live", ...). */
  videosInChannel(channelIdOrUrl: string): Promise<FlatEntry[]>;
  /**
   * The videos in one playlist. Bodies that share a channel with their
   * siblings (the Assembly, P&Z and the school board all publish to the MOA
   * channel) are usually separated by playlist, so this is how a video gets
   * attributed to the right body.
   */
  videosInPlaylist(playlistIdOrUrl: string): Promise<FlatEntry[]>;
}

/** A {@link YouTube} that uses `config`. Does no I/O until a method is called. */
export function youtube(config: YouTubeConfig = {}): YouTube {
  return {
    videosInChannel: (channelIdOrUrl) =>
      flatPlaylist(config, channelUrl(channelIdOrUrl)),
    videosInPlaylist: (playlistIdOrUrl) =>
      flatPlaylist(config, playlistUrl(playlistIdOrUrl)),
    getMetadata: (videoIdOrUrl) => getMetadata(config, videoIdOrUrl),
    ensureAudioDownloaded: (videoIdOrUrl, path, options) =>
      ensureAudioDownloaded(config, videoIdOrUrl, path, options),
  };
}

/**
 * A {@link YouTube} configured from environment variables:
 * - YOUTUBE_COOKIES: {@link YouTubeConfig.cookies}
 */
export function youtubeFromEnv(env = process.env): YouTube {
  return youtube({ cookies: env.YOUTUBE_COOKIES || undefined });
}
