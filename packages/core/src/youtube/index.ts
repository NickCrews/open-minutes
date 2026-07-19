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

export async function videosInChannel(channelIdOrUrl: string) {
  const { stdout } = await execFileAsync(
    "yt-dlp",
    ["--flat-playlist", "-J", channelUrl(channelIdOrUrl)],
    {
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const playlist = JSON.parse(stdout) as {
    entries: Array<{
      id: string;
      title?: string;
    }>;
  };
  return playlist.entries;
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
