import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AudioProvider } from "@open-minutes/core/audio-provider";
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
 * Where {@link storedYoutube} looks for videos. See
 * {@link blobStoreConfigFromEnv} for where each comes from.
 */
export interface BlobStoreConfig {
  /** The blob store's public base URL. */
  url: string;
  /**
   * A GitHub token allowed to run the fetch-youtube-audio workflow. With it,
   * a video missing from the store is fetched into it by that workflow;
   * without it, `youtube` fetches it locally.
   */
  dispatchToken?: string;
}

/**
 * YouTube videos' metadata and audio from the blob store, where the
 * fetch-youtube-audio workflow puts them (see ./fetch-youtube-audio), so
 * this works where YouTube blocks yt-dlp (CI, servers). When the store can't
 * supply a video, `youtube` gets it instead.
 *
 * The stored audio is a speech-quality re-encode of YouTube's (still Opus in
 * WebM), so decoded it is very close to what `youtube` downloads (correlation
 * ~0.997 on speech, same length, no lag) but not byte-identical; golden
 * fixtures' sha256 are of the stored audio's WAV.
 */
export function storedYoutube(
  youtube: YouTube,
  store: BlobStoreConfig,
): AudioProvider {
  const blobs = blobStore(store.url);
  const fetchFile = (
    id: string,
    pick: Parameters<typeof fetchYoutubeVideoFile>[2],
  ) => fetchYoutubeVideoFile(blobs, id, pick, store.dispatchToken);
  return {
    audioExtension: youtube.audioExtension,
    async getMetadata(videoIdOrUrl) {
      const info = await fetchFile(videoId(videoIdOrUrl), (k) => k.infoJson);
      return info
        ? metadataFromYtDlpInfo(parseJson(info) as YtDlpInfo)
        : youtube.getMetadata(videoIdOrUrl);
    },
    async ensureAudioDownloaded(
      videoIdOrUrl,
      path,
      { overwrite = false } = {},
    ) {
      const exists = await access(path).then(
        () => true,
        () => false,
      );
      if (exists && !overwrite) return { downloaded: false };

      const id = videoId(videoIdOrUrl);
      // Progress goes to stderr so callers' stdout stays machine-readable.
      console.error(`Getting audio for ${id} from the blob store...`);
      const webm = await fetchFile(id, (k) => k.speechWebm);
      if (!webm) {
        return youtube.ensureAudioDownloaded(videoIdOrUrl, path, { overwrite });
      }
      await mkdir(dirname(path), { recursive: true });
      // Written beside `path` and moved into place, so an interrupted write
      // never leaves a partial file at `path`.
      await writeFile(`${path}.part`, webm);
      await rename(`${path}.part`, path);
      return { downloaded: true };
    },
  };
}

/**
 * The blob store from environment variables, or null if
 * BLOB_STORE_PUBLIC_URL isn't set:
 * - BLOB_STORE_PUBLIC_URL: {@link BlobStoreConfig.url}
 * - YOUTUBE_AUDIO_DISPATCH_TOKEN: {@link BlobStoreConfig.dispatchToken}
 */
export function blobStoreConfigFromEnv(
  env = process.env,
): BlobStoreConfig | null {
  if (!env.BLOB_STORE_PUBLIC_URL) return null;
  return {
    url: env.BLOB_STORE_PUBLIC_URL,
    dispatchToken: env.YOUTUBE_AUDIO_DISPATCH_TOKEN || undefined,
  };
}

/**
 * YouTube configured from the environment (see `youtubeFromEnv`), behind the
 * blob store when one is configured (see {@link blobStoreConfigFromEnv}).
 */
export function storedYoutubeFromEnv(env = process.env): AudioProvider {
  const youtube = youtubeFromEnv(env);
  const store = blobStoreConfigFromEnv(env);
  return store ? storedYoutube(youtube, store) : youtube;
}
