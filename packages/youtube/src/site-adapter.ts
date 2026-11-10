import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type RecordingMetadata,
  type SiteAdapter,
  metadataFromJson,
} from "@open-minutes/core/site";
import {
  type Egress,
  EgressError,
  type EgressOptions,
  egress,
  ensureYtDlpInstalled,
} from "@open-minutes/ytdlp";
import { decodeOpusWebm, encodeOpusWebm } from "@open-minutes/codecs";
import {
  type YtDlpInfo,
  metadataFromYtDlpInfo,
  videoId,
  videoUrl,
} from "./core";
import { type FetchedVideo, fetchVideoViaWorkflow } from "./workflow-fetch";

/** How {@link youtube} reaches YouTube through yt-dlp. */
export interface YouTubeOptions {
  /**
   * The routes yt-dlp tries and how they're set up (see `@open-minutes/ytdlp`):
   * - `EgressOptions`, such as `{ routes, install }`: each yt-dlp run starts
   *   and stops its own daemons.
   * - An `Egress` manager from `egress()`: every run shares its routes and
   *   daemons, for a process that gets many videos. The caller closes it.
   *
   * Default: `{}`, so `YOUTUBE_EGRESS`, else direct, then WARP, then Tor, and
   * nothing installed.
   */
  egress?: Egress | EgressOptions;
}

/**
 * Runs yt-dlp through the egress routes, installing yt-dlp first if it's
 * missing. Rejects with an `EgressError` when YouTube refused every route.
 */
async function ytDlp(
  options: YouTubeOptions,
  args: string[],
  {
    beforeAttempt,
    signal,
  }: { beforeAttempt?: () => Promise<void>; signal?: AbortSignal } = {},
) {
  await ensureYtDlpInstalled();
  const manager = egress(options.egress);
  try {
    return await manager.run(args, { beforeAttempt, signal });
  } finally {
    await manager.close();
  }
}

async function getMetadata(
  options: YouTubeOptions,
  videoIdOrUrl: string,
): Promise<RecordingMetadata> {
  const { stdout } = await ytDlp(options, [
    "--skip-download",
    "-J",
    videoUrl(videoIdOrUrl),
  ]);
  return metadataFromYtDlpInfo(JSON.parse(stdout) as YtDlpInfo);
}

/**
 * Downloads a video's audio with yt-dlp and writes it to `path` re-encoded for
 * speech (see `encodeOpusWebm` in `@open-minutes/codecs`). A single format
 * needs no ffmpeg to download.
 */
async function downloadAudio(
  options: YouTubeOptions,
  videoIdOrUrl: string,
  path: string,
  { signal }: { signal?: AbortSignal } = {},
) {
  await mkdir(dirname(path), { recursive: true });
  const url = videoUrl(videoIdOrUrl);
  // Progress goes to stderr so callers' stdout stays machine-readable.
  console.error(`Downloading audio for ${url} to ${path}...`);
  // YouTube's audio waits beside `path` until it's re-encoded.
  const webm = `${path}.download.webm`;
  const removeWebm = async () => {
    await rm(webm, { force: true });
    await rm(`${webm}.part`, { force: true });
  };
  try {
    // Format 249 is YouTube's smallest Opus (~50 kbps, ~22 MB per hour),
    // still well above what the re-encode keeps. Videos without it get their
    // best WebM audio.
    await ytDlp(
      options,
      ["-f", "249/bestaudio[ext=webm]", "--no-playlist", "-o", webm, url],
      { beforeAttempt: removeWebm, signal },
    );
    console.error(`Re-encoding the audio for speech...`);
    await writeAtomically(
      path,
      await encodeOpusWebm(decodeOpusWebm(await readFile(webm))),
    );
  } finally {
    await removeWebm();
  }
}

/**
 * Writes `bytes` beside `path` and moves them into place, so an interrupted
 * write never leaves a partial file at `path`.
 */
async function writeAtomically(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
}

/**
 * A video's metadata and audio from YouTube. Create one with {@link youtube}
 * and pass it around; tests pass a fake instead (see the pipeline's
 * `om/testing.ts`).
 */
export type YouTube = SiteAdapter & { readonly site: "youtube" };

/**
 * A {@link YouTube} that gets each video the first way that works:
 * 1. yt-dlp through the egress routes (`options.egress`, else
 *    `YOUTUBE_EGRESS`, else direct, then WARP, then Tor).
 * 2. The fetch-youtube-audio workflow (see {@link fetchVideoViaWorkflow}),
 *    when YouTube refuses every route, if `YOUTUBE_AUDIO_DISPATCH_TOKEN` is
 *    set. It runs this same code on a GitHub runner.
 *
 * Either way, the audio is YouTube's re-encoded for speech: 16 kHz mono Opus
 * in WebM at 24 kbps (see `encodeOpusWebm` in `@open-minutes/codecs`).
 *
 * Any other error, such as a private or removed video, is thrown at once.
 * Does no I/O until a method is called. Given a {@link YouTube} instead of
 * options, returns it, so code handed either can call `youtube()`.
 */
export function youtube(options: YouTube | YouTubeOptions = {}): YouTube {
  if ("site" in options) return options;
  // One workflow run per video, however many of its files are asked for.
  const fetched = new Map<string, Promise<FetchedVideo>>();
  const fetchViaWorkflow = (id: string, blocked: EgressError) => {
    const token = process.env.YOUTUBE_AUDIO_DISPATCH_TOKEN;
    if (!token) {
      throw new Error(
        `${blocked.message}\nSet YOUTUBE_AUDIO_DISPATCH_TOKEN to have the fetch-youtube-audio workflow fetch ${id} instead.`,
        { cause: blocked },
      );
    }
    let video = fetched.get(id);
    if (!video) {
      video = fetchVideoViaWorkflow(id, token);
      // A failed run isn't remembered, so a later call tries again.
      video.catch(() => fetched.delete(id));
      fetched.set(id, video);
    }
    return video;
  };
  /** `viaYtDlp()`, or `fromWorkflow` if YouTube refused yt-dlp every route. */
  async function orViaWorkflow<T>(
    videoIdOrUrl: string,
    viaYtDlp: () => Promise<T>,
    fromWorkflow: (video: FetchedVideo) => Promise<T>,
  ): Promise<T> {
    try {
      return await viaYtDlp();
    } catch (error) {
      if (!(error instanceof EgressError)) throw error;
      const id = videoId(videoIdOrUrl);
      return fromWorkflow(await fetchViaWorkflow(id, error));
    }
  }
  return {
    site: "youtube",
    recordingId: videoId,
    permalink: (videoIdOrUrl) => videoUrl(videoId(videoIdOrUrl)),
    getMetadata: (videoIdOrUrl) =>
      orViaWorkflow(
        videoIdOrUrl,
        () => getMetadata(options, videoIdOrUrl),
        async ({ metadataJson }) => metadataFromJson(metadataJson),
      ),
    downloadAudio: (videoIdOrUrl, path, downloadOptions) =>
      orViaWorkflow(
        videoIdOrUrl,
        () => downloadAudio(options, videoIdOrUrl, path, downloadOptions),
        ({ speechWebm }) => writeAtomically(path, speechWebm),
      ),
  };
}
