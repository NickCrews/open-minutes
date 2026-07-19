import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

export function channelUrl(channelIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (channelIdOrUrl.includes("youtube.com")) {
    return channelIdOrUrl;
  }
  return `https://www.youtube.com/channel/${channelIdOrUrl}`;
}

export function videoUrl(videoIdOrUrl: string) {
  // if youtube.com already, return as-is
  if (videoIdOrUrl.includes("youtube.com")) {
    return videoIdOrUrl;
  }
  return `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
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

export async function videosInChannel(channelIdOrUrl: string) {
  const { stdout } = await execFileAsync(
    "yt-dlp",
    ["--flat-playlist", "-J", channelUrl(channelIdOrUrl)],
    {
      // A busy channel's flat playlist runs to several MB.
      maxBuffer: 100 * 1024 * 1024,
    },
  );
  return flattenVideos(JSON.parse(stdout) as FlatEntry);
}

export interface VideoMetadata {
  id: string;
  /** The YouTube channel the video was published on (eg "UCOUlNInprZEjhbpVPiJOlEA"). */
  channelId: string;
  title: string;
  description: string;
  durationSecs: number | null;
}

export async function fetchVideoMetadata(
  videoIdOrUrl: string,
): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync(
    "yt-dlp",
    ["--skip-download", "-J", videoUrl(videoIdOrUrl)],
    {
      maxBuffer: 100 * 1024 * 1024,
    },
  );
  const raw = JSON.parse(stdout) as {
    id: string;
    channel_id?: string;
    title?: string;
    description?: string;
    duration?: number | null;
  };
  return {
    id: raw.id,
    channelId: raw.channel_id ?? "",
    title: raw.title ?? "",
    description: raw.description ?? "",
    durationSecs: raw.duration ?? null,
  };
}

/**
 * Everything that touches YouTube (via yt-dlp), as an injectable boundary so
 * callers like the ingestion pipeline can be tested without network access.
 */
export interface YouTube {
  videosInChannel: typeof videosInChannel;
  fetchVideoMetadata: typeof fetchVideoMetadata;
  downloadVideoAudio: typeof downloadVideoAudio;
}

/** The real yt-dlp-backed implementation of the {@link YouTube} boundary. */
export const realYouTube: YouTube = {
  videosInChannel,
  fetchVideoMetadata,
  downloadVideoAudio,
};

export async function downloadVideoAudio(
  youtubeIdOrUrl: string,
  path: string,
  onExists: "skip" | "overwrite" = "skip",
) {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true });
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  const shouldDownload = onExists === "overwrite" || !exists;
  if (shouldDownload) {
    const url = videoUrl(youtubeIdOrUrl);
    // Progress goes to stderr so callers' stdout stays machine-readable.
    console.error(`Downloading audio for ${url} to ${path}...`);
    await execFileAsync("yt-dlp", [
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
  return { downloaded: false };
}
