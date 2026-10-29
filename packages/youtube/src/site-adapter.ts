import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RecordingMetadata,
  SiteAdapter,
} from "@open-minutes/core/site-adapter";
import {
  EgressError,
  ensureYtDlpInstalled,
  runWithEgress,
} from "@open-minutes/ytdlp";
import { encodeSpeechWebm } from "@open-minutes/codecs";
import {
  type YtDlpInfo,
  metadataFromJson,
  metadataFromYtDlpInfo,
  videoId,
  videoUrl,
} from "./core";
import { type FetchedVideo, fetchVideoViaWorkflow } from "./workflow-fetch";

/**
 * Runs yt-dlp through the egress routes (see `runWithEgress` in
 * `@open-minutes/ytdlp`; by default `YOUTUBE_EGRESS`, else direct, then
 * WARP, then Tor), installing yt-dlp first if it's missing. Rejects with an
 * `EgressError` when YouTube refused every route.
 */
async function ytDlp(
  args: string[],
  {
    beforeAttempt,
    signal,
  }: { beforeAttempt?: () => Promise<void>; signal?: AbortSignal } = {},
) {
  await ensureYtDlpInstalled();
  return runWithEgress(args, { beforeAttempt, signal });
}

async function getMetadata(videoIdOrUrl: string): Promise<RecordingMetadata> {
  const { stdout } = await ytDlp([
    "--skip-download",
    "-J",
    videoUrl(videoIdOrUrl),
  ]);
  return metadataFromYtDlpInfo(JSON.parse(stdout) as YtDlpInfo);
}

/**
 * Downloads a video's audio with yt-dlp and writes it to `path` re-encoded for
 * speech (see `encodeSpeechWebm` in `@open-minutes/codecs`). A single format
 * needs no ffmpeg to download.
 */
async function downloadAudio(
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
      ["-f", "249/bestaudio[ext=webm]", "--no-playlist", "-o", webm, url],
      { beforeAttempt: removeWebm, signal },
    );
    console.error(`Re-encoding the audio for speech...`);
    await writeAtomically(path, await encodeSpeechWebm(await readFile(webm)));
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
export type YouTube = SiteAdapter & {
  readonly site: "youtube";
  readonly audioExtension: "webm";
};

/**
 * A {@link YouTube} that gets each video the first way that works:
 * 1. yt-dlp through the egress routes (`YOUTUBE_EGRESS`, else direct, then
 *    WARP, then Tor).
 * 2. The fetch-youtube-audio workflow (see {@link fetchVideoViaWorkflow}),
 *    when YouTube refuses every route, if `YOUTUBE_AUDIO_DISPATCH_TOKEN` is
 *    set. It runs this same code on a GitHub runner.
 *
 * Either way, the audio is YouTube's re-encoded for speech: 16 kHz mono Opus
 * in WebM at 24 kbps (see `encodeSpeechWebm` in `@open-minutes/codecs`).
 *
 * Any other error, such as a private or removed video, is thrown at once.
 * Does no I/O until a method is called.
 */
export function youtube(): YouTube {
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
    audioExtension: "webm",
    getMetadata: (videoIdOrUrl) =>
      orViaWorkflow(
        videoIdOrUrl,
        () => getMetadata(videoIdOrUrl),
        async ({ metadataJson }) => metadataFromJson(metadataJson),
      ),
    downloadAudio: (videoIdOrUrl, path, options) =>
      orViaWorkflow(
        videoIdOrUrl,
        () => downloadAudio(videoIdOrUrl, path, options),
        ({ speechWebm }) => writeAtomically(path, speechWebm),
      ),
  };
}
