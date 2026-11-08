import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Site,
  type SiteAdapter,
  metadataFromJson,
  metadataToJson,
} from "@open-minutes/core/site";
import {
  type BlobStore,
  type BlobStoreWriter,
  blobStore,
  blobStoreWriterFromEnv,
} from "@open-minutes/blobstore";
import { akleg } from "@open-minutes/akleg";
import { youtube } from "@open-minutes/youtube";

/**
 * `adapter`'s recordings' metadata and audio from the blob store first, so
 * this works where the site blocks downloads (YouTube blocks yt-dlp from CI
 * and servers) or stops serving a recording. What `store` (by default
 * `blobStore()`) doesn't have, `adapter` gets, and with `writer`, it's
 * stored, so the next miss is a hit.
 *
 * The audio is 16 kHz mono Opus in WebM, as every `SiteAdapter.downloadAudio`
 * saves it, stored as is. Golden fixtures' sha256 are of its decoded WAV.
 */
export function storedSite(
  adapter: SiteAdapter,
  {
    store: blobs = blobStore(),
    writer,
  }: { store?: BlobStore; writer?: BlobStoreWriter | null } = {},
): SiteAdapter {
  const filesOf = (recordingIdOrUrl: string) => {
    const id = adapter.recordingId(recordingIdOrUrl);
    return { id, files: blobs.recording(adapter.site, id) };
  };
  return {
    site: adapter.site,
    recordingId: (recordingIdOrUrl) => adapter.recordingId(recordingIdOrUrl),
    permalink: (recordingIdOrUrl) => adapter.permalink(recordingIdOrUrl),
    async getMetadata(recordingIdOrUrl) {
      const { id, files } = filesOf(recordingIdOrUrl);
      const stored = await files.metadataJson.get();
      if (stored) return metadataFromJson(stored);
      const metadata = await adapter.getMetadata(id);
      // No duration means the site has no audio for it yet (an akleg.gov
      // meeting not yet posted, a YouTube stream still live), so its
      // metadata isn't final and isn't stored.
      if (writer && metadata.durationSecs !== null) {
        await writer.put(files.metadataJson, metadataToJson(metadata));
        console.error(`Stored ${id}'s metadata in the blob store.`);
      }
      return metadata;
    },
    async downloadAudio(recordingIdOrUrl, path, { signal } = {}) {
      const { id, files } = filesOf(recordingIdOrUrl);
      // Progress goes to stderr so callers' stdout stays machine-readable.
      console.error(`Getting audio for ${id} from the blob store...`);
      const stored = await files.audio.get();
      if (!stored) {
        await adapter.downloadAudio(id, path, { signal });
        if (writer) {
          const audio = new Uint8Array(await readFile(path));
          await writer.put(files.audio, audio);
          console.error(`Stored ${id}'s audio in the blob store.`);
        }
        return;
      }
      await mkdir(dirname(path), { recursive: true });
      // Written beside `path` and moved into place, so an interrupted write
      // never leaves a partial file at `path`.
      await writeFile(`${path}.part`, stored);
      await rename(`${path}.part`, path);
    },
  };
}

/**
 * {@link storedSite} for `site`, configured from the environment: the blob
 * store from BLOB_STORE_PUBLIC_URL (see `blobStore`) and its keys (see
 * `blobStoreWriterFromEnv`). For YouTube, `youtube()`, which reads
 * YOUTUBE_EGRESS and YOUTUBE_AUDIO_DISPATCH_TOKEN; for akleg.gov, `akleg()`.
 */
export function storedSiteFromEnv(
  site: Site,
  env: Record<string, string | undefined> = process.env,
): SiteAdapter {
  return storedSite(siteAdapter(site), {
    writer: blobStoreWriterFromEnv(env),
  });
}

/**
 * The adapter that reaches `site` itself, configured from the environment
 * (see {@link storedSiteFromEnv}). Does no I/O until a method is called.
 */
export function siteAdapter(site: Site): SiteAdapter {
  switch (site) {
    case "youtube":
      return youtube();
    case "akleg":
      return akleg();
  }
}
