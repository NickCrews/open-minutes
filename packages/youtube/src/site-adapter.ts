import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RecordingMetadata,
  SiteAdapter,
} from "@open-minutes/core/site-adapter";
import {
  type Egress,
  type Route,
  ensureYtDlpInstalled,
  runWithEgress,
} from "@open-minutes/ytdlp";
import { type YtDlpInfo, metadataFromYtDlpInfo, videoUrl } from "./core";

/** How to reach YouTube. */
interface YouTubeConfig {
  /**
   * The routes yt-dlp tries for a video's metadata and audio (see
   * `runWithEgress` in `@open-minutes/ytdlp`; by default `YOUTUBE_EGRESS`,
   * else direct, then WARP, then Tor).
   */
  routes?: Route[];
  /**
   * An egress manager to run yt-dlp through instead, which keeps WARP and
   * Tor up between calls, for a caller that makes many, like a scout. It
   * brings its own routes, so {@link YouTubeConfig.routes} is ignored. The
   * caller closes it.
   */
  egress?: Egress;
}

/**
 * Runs yt-dlp through `config`'s routes, installing yt-dlp first if it's
 * missing.
 */
async function ytDlpWithEgress(
  config: YouTubeConfig,
  args: string[],
  {
    beforeAttempt,
    signal,
  }: { beforeAttempt?: () => Promise<void>; signal?: AbortSignal } = {},
) {
  await ensureYtDlpInstalled();
  return config.egress
    ? config.egress.run(args, { beforeAttempt, signal })
    : runWithEgress(args, { routes: config.routes, beforeAttempt, signal });
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

/**
 * Downloads a video's original Opus-in-WebM audio to `path` with yt-dlp. A
 * single format needs no ffmpeg to download.
 */
async function downloadAudio(
  config: YouTubeConfig,
  videoIdOrUrl: string,
  path: string,
  { signal }: { signal?: AbortSignal } = {},
) {
  await mkdir(dirname(path), { recursive: true });
  const url = videoUrl(videoIdOrUrl);
  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(`Downloading audio for ${url} to ${path}...`);
  // Downloaded beside `path` and moved into place, so an interrupted download
  // never leaves a partial file at `path`.
  const webm = `${path}.download.webm`;
  const removeWebm = async () => {
    await rm(webm, { force: true });
    await rm(`${webm}.part`, { force: true });
  };
  try {
    // The format the fetch-youtube-audio workflow re-encodes from.
    await ytDlpWithEgress(
      config,
      ["-f", "bestaudio[ext=webm]", "--no-playlist", "-o", webm, url],
      { beforeAttempt: removeWebm, signal },
    );
    await rename(webm, path);
  } finally {
    await removeWebm();
  }
}

/**
 * A video's metadata and audio from YouTube (via yt-dlp). Create one with
 * {@link youtube} and pass it around; tests pass a
 * fake instead (see the pipeline's `om/testing.ts`).
 */
export type YouTube = SiteAdapter & {
  readonly site: "youtube";
  readonly audioExtension: "webm";
};

/** A {@link YouTube} that uses `config`. Does no I/O until a method is called. */
export function youtube(config: YouTubeConfig = {}): YouTube {
  return {
    site: "youtube",
    audioExtension: "webm",
    getMetadata: (videoIdOrUrl) => getMetadata(config, videoIdOrUrl),
    downloadAudio: (videoIdOrUrl, path, options) =>
      downloadAudio(config, videoIdOrUrl, path, options),
  };
}
