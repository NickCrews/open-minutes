import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SiteAdapter } from "@open-minutes/core/site-adapter";
import {
  type BlobStore,
  type BlobStoreWriter,
  blobStore,
  blobStoreWriterFromEnv,
} from "@open-minutes/blobstore";
import {
  type YouTube,
  type YtDlpInfo,
  metadataFromJson,
  metadataFromYtDlpInfo,
  metadataToJson,
  videoId,
  youtube,
} from "@open-minutes/youtube";

/**
 * YouTube videos' metadata and audio from the blob store, so this works
 * where YouTube blocks yt-dlp (CI, servers). What `store` (by default
 * `blobStore()`) doesn't have, `youtube` gets, and with `writer`, it's
 * stored, so the next miss is a hit.
 *
 * The audio is what `youtube` gives: YouTube's re-encoded for speech (still
 * Opus in WebM). Golden fixtures' sha256 are of the stored audio's WAV.
 */
export function storedYoutube(
  youtube: YouTube,
  {
    store: blobs = blobStore(),
    writer,
  }: { store?: BlobStore; writer?: BlobStoreWriter | null } = {},
): SiteAdapter {
  return {
    site: youtube.site,
    audioExtension: youtube.audioExtension,
    async getMetadata(videoIdOrUrl) {
      const id = videoId(videoIdOrUrl);
      const files = blobs.youtube(id);
      const stored = await files.metadataJson.get();
      if (stored) return metadataFromJson(stored);
      const info = await files.ytDlpInfoJson.get();
      const metadata = info
        ? metadataFromYtDlpInfo(
            JSON.parse(new TextDecoder().decode(info)) as YtDlpInfo,
          )
        : await youtube.getMetadata(id);
      if (writer) {
        await writer.put(
          files.metadataJson,
          metadataToJson(metadata),
          "application/json",
        );
        console.error(`Stored ${id}'s metadata in the blob store.`);
      }
      return metadata;
    },
    async downloadAudio(videoIdOrUrl, path, { signal } = {}) {
      const id = videoId(videoIdOrUrl);
      const files = blobs.youtube(id);
      // Progress goes to stderr so callers' stdout stays machine-readable.
      console.error(`Getting audio for ${id} from the blob store...`);
      const webm = await files.speechWebm.get();
      if (!webm) {
        await youtube.downloadAudio(id, path, { signal });
        if (writer) {
          const audio = new Uint8Array(await readFile(path));
          await writer.put(files.speechWebm, audio, "audio/webm");
          console.error(`Stored ${id}'s audio in the blob store.`);
        }
        return;
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
 * {@link storedYoutube} configured from the environment: the blob store from
 * BLOB_STORE_PUBLIC_URL (see `blobStore`) and its keys (see
 * `blobStoreWriterFromEnv`), and `youtube()`, which reads YOUTUBE_EGRESS and
 * YOUTUBE_AUDIO_DISPATCH_TOKEN.
 */
export function storedYoutubeFromEnv(env = process.env): SiteAdapter {
  return storedYoutube(youtube(), { writer: blobStoreWriterFromEnv(env) });
}
