import type { BlobStore, BlobStoreWriter } from "./index";
import { storeOf } from "./layout";

/** A blob in a {@link memoryBlobStore}. */
export interface MemoryBlob {
  body: Uint8Array;
  contentType: string;
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
  const store = storeOf((key) => ({
    key,
    url: `memory:${key}`,
    get: async () => blobs.get(key)?.body ?? null,
  }));
  const writer: BlobStoreWriter = {
    put: async (file, body, contentType) => {
      blobs.set(file.key, { body, contentType });
    },
  };
  return { store, writer, blobs };
}
