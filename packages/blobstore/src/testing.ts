import type { BlobStore, BlobStoreWriter, ContentType } from "./index";
import { storeOf } from "./layout";

/** A blob in a {@link memoryBlobStore}. */
export interface MemoryBlob {
  body: Uint8Array;
  contentType: ContentType;
}

/**
 * An empty blob store kept in memory, with the same keys as `blobStore()`,
 * and a writer to it. `blobs` holds what was written, by key.
 */
export function memoryBlobStore(): {
  store: BlobStore;
  writer: BlobStoreWriter;
  blobs: Map<string, MemoryBlob>;
} {
  const blobs = new Map<string, MemoryBlob>();
  const store = storeOf((key, contentType) => ({
    key,
    url: `memory:${key}`,
    contentType,
    get: async () => blobs.get(key)?.body ?? null,
  }));
  const writer: BlobStoreWriter = {
    put: async (file, body) => {
      blobs.set(file.key, { body, contentType: file.contentType });
    },
  };
  return { store, writer, blobs };
}
