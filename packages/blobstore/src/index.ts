/**
 * The project's blob store: an S3-compatible bucket of blobs (Cloudflare
 * R2), publicly readable at {@link BLOB_STORE_PUBLIC_URL}, one top-level
 * prefix per kind of file. It uses only `fetch`, so the browser can use it
 * too.
 */

/**
 * The blob store's public base URL: the project's Cloudflare R2 bucket.
 * Where BLOB_STORE_PUBLIC_URL is set (the web app's wrangler.jsonc, CI), it
 * should be this.
 */
export const BLOB_STORE_PUBLIC_URL =
  "https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev";

/** Read access to the blob store; see {@link blobStore}. */
export interface BlobStore {
  /** The public URL of the file at `key`, like `exports/open-minutes.duckdb`. */
  url(key: string): string;
  /**
   * The contents of the file at `key`, or null if there's none. Throws on any
   * other failure. `bypassCache` gets past a CDN's cached 404, for polling
   * until a file appears.
   */
  get(
    key: string,
    options?: { bypassCache?: boolean },
  ): Promise<Uint8Array | null>;
}

/**
 * The blob store at `base` (by default, {@link BLOB_STORE_PUBLIC_URL}).
 * Does no I/O until {@link BlobStore.get}.
 */
export function blobStore(base: string = BLOB_STORE_PUBLIC_URL): BlobStore {
  const url = (key: string) => `${base.replace(/\/$/, "")}/${key}`;
  return {
    url,
    async get(key, { bypassCache = false } = {}) {
      const get = bypassCache ? `${url(key)}?t=${Date.now()}` : url(key);
      const res = await fetch(get);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${get}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
