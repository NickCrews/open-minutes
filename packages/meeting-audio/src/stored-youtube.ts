import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SiteAdapter } from "@open-minutes/core/site-adapter";
import {
  type BlobStoreWriter,
  blobStore,
  blobStoreWriterFromEnv,
} from "@open-minutes/blobstore";
import {
  type FetchedVideo,
  type YouTube,
  type YtDlpInfo,
  fetchVideoViaWorkflow,
  metadataFromYtDlpInfo,
  videoId,
  youtube,
} from "@open-minutes/youtube";

/**
 * YouTube videos' metadata and audio from the blob store, so this works
 * where YouTube blocks yt-dlp (CI, servers). When the store can't supply a
 * video, `youtube` gets it instead.
 *
 * With `dispatchToken` (a GitHub token allowed to run the fetch-youtube-audio
 * workflow), a video missing from the store is fetched by that workflow
 * instead (see `fetchVideoViaWorkflow`), which is how CI gets videos YouTube
 * won't give its runners. With `writer` too, what the workflow fetched is
 * stored, so the next miss is a hit.
 *
 * The stored audio is a speech-quality re-encode of YouTube's (still Opus in
 * WebM), the same as `youtube` downloads; golden fixtures' sha256 are of the
 * stored audio's WAV.
 */
export function storedYoutube(
  youtube: YouTube,
  {
    dispatchToken,
    writer,
  }: { dispatchToken?: string; writer?: BlobStoreWriter | null } = {},
): SiteAdapter {
  const blobs = blobStore();
  // One workflow run per video, however many of its files are asked for.
  const fetched = new Map<string, Promise<FetchedVideo>>();
  const fetchAndStore = async (
    id: string,
    token: string,
  ): Promise<FetchedVideo> => {
    const video = await fetchVideoViaWorkflow(id, token);
    if (writer) {
      const files = blobs.youtube(id);
      await writer.put(files.infoJson, video.infoJson, "application/json");
      await writer.put(files.speechWebm, video.speechWebm, "audio/webm");
      console.error(`Stored ${id} in the blob store.`);
    }
    return video;
  };
  const getFile = async (
    id: string,
    which: keyof FetchedVideo,
  ): Promise<Uint8Array | null> => {
    const stored = await blobs.youtube(id)[which].get();
    if (stored || !dispatchToken) return stored;
    let video = fetched.get(id);
    if (!video) {
      video = fetchAndStore(id, dispatchToken);
      // A failed run isn't remembered, so a later call tries again.
      video.catch(() => fetched.delete(id));
      fetched.set(id, video);
    }
    return (await video)[which];
  };
  return {
    site: youtube.site,
    audioExtension: youtube.audioExtension,
    async getMetadata(videoIdOrUrl) {
      const info = await getFile(videoId(videoIdOrUrl), "infoJson");
      return info
        ? metadataFromYtDlpInfo(
            JSON.parse(new TextDecoder().decode(info)) as YtDlpInfo,
          )
        : youtube.getMetadata(videoIdOrUrl);
    },
    async downloadAudio(videoIdOrUrl, path, { signal } = {}) {
      const id = videoId(videoIdOrUrl);
      // Progress goes to stderr so callers' stdout stays machine-readable.
      console.error(`Getting audio for ${id} from the blob store...`);
      const webm = await getFile(id, "speechWebm");
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
 * {@link storedYoutube} configured from the environment: yt-dlp's routes from
 * YOUTUBE_EGRESS, the blob store from BLOB_STORE_PUBLIC_URL (see `blobStore`)
 * and its keys (see `blobStoreWriterFromEnv`), and the dispatch token from
 * YOUTUBE_AUDIO_DISPATCH_TOKEN.
 */
export function storedYoutubeFromEnv(env = process.env): SiteAdapter {
  return storedYoutube(youtube(), {
    dispatchToken: env.YOUTUBE_AUDIO_DISPATCH_TOKEN || undefined,
    writer: blobStoreWriterFromEnv(env),
  });
}
