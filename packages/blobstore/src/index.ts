/**
 * The project's blob store: an S3-compatible bucket of blobs (Cloudflare
 * R2), publicly readable at {env.BLOB_STORE_PUBLIC_URL}, one top-level
 * prefix per kind of file. It uses only `fetch`, so the browser can use it
 * too.
 */
import { AwsClient } from "aws4fetch";
import type { Site } from "@open-minutes/core/site";
import { keyPath, storeOf } from "./layout";

export { recordingDir } from "./layout";

/** One file in the blob store, which may or may not exist yet. */
export interface BlobFile {
  /** Its key in the bucket, like `exports/open-minutes.duckdb`. */
  key: string;
  /** Its public URL. */
  url: string;
  /** The Content-Type it's stored with, like `audio/webm`. */
  contentType: ContentType;
  /** Its contents, or null if it isn't stored. Throws on any other failure. */
  get(): Promise<Uint8Array | null>;
}

/**
 * A MIME type, like `audio/webm`. Editors suggest the common ones listed
 * here, but any string is allowed: `string & {}` keeps TypeScript from
 * merging the list into plain `string`, which would drop the suggestions.
 */
export type ContentType =
  | "application/json"
  | "application/octet-stream"
  | "application/pdf"
  | "audio/mpeg"
  | "audio/ogg"
  | "audio/wav"
  | "audio/webm"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "text/csv"
  | "text/html"
  | "text/plain"
  | "video/mp4"
  | "video/webm"
  | (string & {});

/**
 * What the store keeps for a recording, so it can be had where its site
 * blocks downloads (YouTube blocks yt-dlp from datacenter IPs, like CI's and
 * servers') or stops serving it. `storedSite` in @open-minutes/meeting-audio
 * makes and stores these files.
 *
 * Keyed by the recording's ID, so a recording edited in place on its site
 * (a YouTube video trimmed, or its audio muted over a copyright claim) keeps
 * its old audio here. That's rare for meetings, and the golden fixtures'
 * sha256 checks would catch it.
 */
export interface RecordingFiles {
  /**
   * The recording's `RecordingMetadata` (@open-minutes/core/site) as
   * JSON, with `publishedAt` as an ISO 8601 string.
   */
  metadataJson: BlobFile;
  /**
   * The audio its site's `SiteAdapter.downloadAudio` saves. For YouTube,
   * YouTube's Opus re-encoded to 16 kHz mono Opus in WebM at 24 kbps
   * (~11 MB per hour), plenty for the models, which take 16 kHz mono. For
   * akleg.gov, the meeting's MP3 as akleg.gov serves it.
   */
  audio: BlobFile;
}

/** The blob store's files, by what they are; see {@link blobStore}. */
export interface BlobStore {
  /**
   * A recording's files, by its site and its ID there (a YouTube video ID,
   * or an akleg.gov meeting ID; see `SiteAdapter.recordingId`).
   */
  recording(site: Site, id: string): RecordingFiles;
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
  return storeOf((key, contentType) => {
    const url = `${base.replace(/\/$/, "")}/${keyPath(key)}`;
    return {
      key,
      url,
      contentType,
      async get() {
        const res = await fetch(url);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
    };
  });
}

/** The project's bucket, where BLOB_STORE_PUBLIC_URL isn't set. */
const DEFAULT_BLOB_STORE_PUBLIC_URL =
  "https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev";

/**
 * `url` if given, else the BLOB_STORE_PUBLIC_URL environment variable, else
 * {@link DEFAULT_BLOB_STORE_PUBLIC_URL}.
 */
function baseUrl(url?: string): string {
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
  /**
   * Stores `body` as `file`, with the file's content type, replacing what's
   * there.
   */
  put(file: BlobFile, body: Uint8Array<ArrayBuffer>): Promise<void>;
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
    async put(file, body) {
      const url = `${bucketUrl}/${keyPath(file.key)}`;
      const res = await client.fetch(url, {
        method: "PUT",
        body,
        headers: { "Content-Type": file.contentType },
      });
      if (!res.ok) {
        throw new Error(`PUT ${url}: HTTP ${res.status} ${await res.text()}`);
      }
    },
  };
}

/** The environment variables {@link blobStoreWriterFromEnv} requires. */
const WRITER_ENV = [
  "BLOB_STORE_ENDPOINT",
  "BLOB_STORE_BUCKET",
  "BLOB_STORE_ACCESS_KEY_ID",
  "BLOB_STORE_SECRET_ACCESS_KEY",
] as const;

/**
 * {@link blobStoreWriter} configured from BLOB_STORE_ENDPOINT,
 * BLOB_STORE_BUCKET, BLOB_STORE_ACCESS_KEY_ID, BLOB_STORE_SECRET_ACCESS_KEY
 * and optionally BLOB_STORE_REGION. Null when none of the four are set;
 * throws when only some are, since that's a misconfiguration (like a
 * misspelled secret) that would otherwise skip every write silently.
 */
export function blobStoreWriterFromEnv(
  env: Record<string, string | undefined>,
): BlobStoreWriter | null {
  const missing = WRITER_ENV.filter((name) => !env[name]);
  if (missing.length === WRITER_ENV.length) return null;
  if (missing.length > 0) {
    throw new Error(
      `Blob store writer is partly configured; missing ${missing.join(", ")}.`,
    );
  }
  return blobStoreWriter({
    endpoint: env.BLOB_STORE_ENDPOINT!,
    bucket: env.BLOB_STORE_BUCKET!,
    accessKeyId: env.BLOB_STORE_ACCESS_KEY_ID!,
    secretAccessKey: env.BLOB_STORE_SECRET_ACCESS_KEY!,
    region: env.BLOB_STORE_REGION,
  });
}
