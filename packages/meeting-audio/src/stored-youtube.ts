import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SiteAdapter } from "@open-minutes/core/site-adapter";
import { blobStore } from "@open-minutes/blobstore";
import {
  type YouTube,
  type YtDlpInfo,
  metadataFromYtDlpInfo,
  videoId,
  youtubeFromEnv,
} from "@open-minutes/youtube";
import { fetchYoutubeVideoFile, parseJson } from "./fetch-youtube-audio";

/**
 * YouTube videos' metadata and audio from the blob store, where the
 * fetch-youtube-audio workflow puts them (see ./fetch-youtube-audio), so
 * this works where YouTube blocks yt-dlp (CI, servers). When the store can't
 * supply a video, `youtube` gets it instead.
 *
 * With `dispatchToken` (a GitHub token allowed to run the fetch-youtube-audio
 * workflow), a video missing from the store is first fetched into it by that
 * workflow, which is how CI gets videos YouTube won't give its runners.
 *
 * The stored audio is a speech-quality re-encode of YouTube's (still Opus in
 * WebM), so decoded it is very close to what `youtube` downloads (correlation
 * ~0.997 on speech, same length, no lag) but not byte-identical; golden
 * fixtures' sha256 are of the stored audio's WAV.
 */
export function storedYoutube(
  youtube: YouTube,
  { dispatchToken }: { dispatchToken?: string } = {},
): SiteAdapter {
  const blobs = blobStore();
  const fetchFile = (
    id: string,
    pick: Parameters<typeof fetchYoutubeVideoFile>[2],
  ) => fetchYoutubeVideoFile(blobs, id, pick, dispatchToken);
  return {
    site: youtube.site,
    audioExtension: youtube.audioExtension,
    async getMetadata(videoIdOrUrl) {
      const info = await fetchFile(
        videoId(videoIdOrUrl),
        (files) => files.infoJson,
      );
      return info
        ? metadataFromYtDlpInfo(parseJson(info) as YtDlpInfo)
        : youtube.getMetadata(videoIdOrUrl);
    },
    async downloadAudio(videoIdOrUrl, path, { signal } = {}) {
      const id = videoId(videoIdOrUrl);
      // Progress goes to stderr so callers' stdout stays machine-readable.
      console.error(`Getting audio for ${id} from the blob store...`);
      const webm = await fetchFile(id, (files) => files.speechWebm);
      if (!webm) {
        return youtube.downloadAudio(videoIdOrUrl, path, { signal });
      }
      await mkdir(dirname(path), { recursive: true });
      // Written beside `path` and moved into place, so an interrupted write
      // never leaves a partial file at `path`.
      await writeFile(`${path}.part`, webm);
      await rename(`${path}.part`, path);
    },
  };
}

/**
 * {@link storedYoutube} configured from the environment: YouTube from
 * `youtubeFromEnv`, the blob store from BLOB_STORE_PUBLIC_URL (see
 * `blobStore`), and the dispatch token from YOUTUBE_AUDIO_DISPATCH_TOKEN.
 */
export function storedYoutubeFromEnv(env = process.env): SiteAdapter {
  return storedYoutube(youtubeFromEnv(env), {
    dispatchToken: env.YOUTUBE_AUDIO_DISPATCH_TOKEN || undefined,
  });
}
