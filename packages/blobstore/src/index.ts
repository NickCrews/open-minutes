/**
 * The project's blob store: an S3-compatible bucket of blobs (Cloudflare
 * R2), publicly readable at {env.BLOB_STORE_PUBLIC_URL}, one top-level
 * prefix per kind of file. It uses only `fetch`, so the browser can use it
 * too.
 */
import { AwsClient } from "aws4fetch";

/** One file in the blob store, which may or may not exist yet. */
export interface BlobFile {
  /** Its key in the bucket, like `exports/open-minutes.duckdb`. */
  key: string;
  /** Its public URL. */
  url: string;
  /**
   * Its contents, or null if it isn't stored. Throws on any other failure.
   * `bypassCache` gets past a CDN's cached 404, for polling until it appears.
   */
  get(options?: { bypassCache?: boolean }): Promise<Uint8Array | null>;
}

/**
 * What the store keeps for a YouTube video, since YouTube blocks yt-dlp from
 * datacenter IPs (CI, servers). `storedYoutube` in
 * @open-minutes/meeting-audio makes and stores these files.
 *
 * Keyed by video ID, so a video edited in place on YouTube (trimmed, or audio
 * muted over a copyright claim) keeps its old audio there. That's rare for
 * meetings, and the golden fixtures' sha256 checks would catch it.
 */
export interface YoutubeVideoFiles {
  /**
   * The video's `RecordingMetadata` (@open-minutes/core/site-adapter) as
   * JSON, with `publishedAt` as an ISO 8601 string.
   */
  metadataJson: BlobFile;
  /**
   * YouTube's Opus audio re-encoded to 16 kHz mono Opus in WebM at 24 kbps
   * (~11 MB per hour), plenty for the models, which take 16 kHz mono.
   */
  speechWebm: BlobFile;
}

/** The blob store's files, by what they are; see {@link blobStore}. */
export interface BlobStore {
  /** A YouTube video's files. */
  youtube(youtubeId: string): YoutubeVideoFiles;
  /**
   * Production's public data as one DuckDB file, rebuilt nightly by the
   * export-duckdb workflow (.github/workflows/export-duckdb.yml).
   */
  duckdbExport: BlobFile;
}

/**
 * The blob store at `base`. By default, the BLOB_STORE_PUBLIC_URL environment
 * variable where there is an environment (Node, the web app's Worker), else
 * {@link DEFAULT_BLOB_STORE_PUBLIC_URL}; the browser passes the URL the server
 * configured it with. Does no I/O until a {@link BlobFile.get}.
 */
export function blobStore(base?: string): BlobStore {
  base = baseUrl(base);
  const file = (key: string): BlobFile => {
    const url = `${base.replace(/\/$/, "")}/${key}`;
    return {
      key,
      url,
      async get({ bypassCache = false } = {}) {
        const get = bypassCache ? `${url}?t=${Date.now()}` : url;
        const res = await fetch(get);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GET ${get}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
    };
  };
  return {
    youtube(youtubeId) {
      const prefix = `youtube/${encodeURIComponent(youtubeId)}`;
      return {
        metadataJson: file(`${prefix}/metadata.json`),
        speechWebm: file(`${prefix}/speech.webm`),
      };
    },
    duckdbExport: file("exports/open-minutes.duckdb"),
  };
}

/**
 * the default where the BLOB_STORE_PUBLIC_URL environment variable isn't set.
 */
const DEFAULT_BLOB_STORE_PUBLIC_URL =
  "https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev";

/**
 * Returns the base URL for the blob store, using the provided `url` if given,
 * otherwise falling back to the BLOB_STORE_PUBLIC_URL environment variable or
 * the default URL.
 */
export function baseUrl(url?: string): string {
  if (url) return url;
  // The browser has no `process`.
  const env = (globalThis as { process?: { env: Record<string, unknown> } })
    .process?.env;
  const fromEnv = env?.BLOB_STORE_PUBLIC_URL;
  return typeof fromEnv === "string" && fromEnv
    ? fromEnv
    : DEFAULT_BLOB_STORE_PUBLIC_URL;
}

/** Writes files to the blob store, which takes its S3 API keys. */
export interface BlobStoreWriter {
  /** Stores `body` as `file`, replacing what's there. */
  put(
    file: BlobFile,
    body: Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<void>;
}

/** Where the blob store's S3 API is and the keys to write to it. */
export interface BlobStoreKeys {
  /**
   * For R2, https://<account id>.r2.cloudflarestorage.com; for S3,
   * https://s3.<region>.amazonaws.com.
   */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Defaults to "auto", which R2 wants. */
  region?: string;
}

/** A writer to the bucket that `keys` names. */
export function blobStoreWriter(keys: BlobStoreKeys): BlobStoreWriter {
  const client = new AwsClient({
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    service: "s3",
    region: keys.region || "auto",
  });
  const bucketUrl = `${keys.endpoint.replace(/\/$/, "")}/${keys.bucket}`;
  return {
    async put(file, body, contentType) {
      const url = `${bucketUrl}/${file.key}`;
      const res = await client.fetch(url, {
        method: "PUT",
        body,
        headers: { "Content-Type": contentType },
      });
      if (!res.ok) {
        throw new Error(`PUT ${url}: HTTP ${res.status} ${await res.text()}`);
      }
    },
  };
}

/**
 * {@link blobStoreWriter} configured from BLOB_STORE_ENDPOINT,
 * BLOB_STORE_BUCKET, BLOB_STORE_ACCESS_KEY_ID, BLOB_STORE_SECRET_ACCESS_KEY
 * and optionally BLOB_STORE_REGION, or null unless all four are set.
 */
export function blobStoreWriterFromEnv(
  env: Record<string, string | undefined>,
): BlobStoreWriter | null {
  const endpoint = env.BLOB_STORE_ENDPOINT;
  const bucket = env.BLOB_STORE_BUCKET;
  const accessKeyId = env.BLOB_STORE_ACCESS_KEY_ID;
  const secretAccessKey = env.BLOB_STORE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return blobStoreWriter({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.BLOB_STORE_REGION,
  });
}
