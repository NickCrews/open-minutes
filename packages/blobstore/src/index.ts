/**
 * The project's blob store: an S3-compatible bucket of blobs (Cloudflare
 * R2), publicly readable at {env.BLOB_STORE_PUBLIC_URL}, one top-level
 * prefix per kind of file. It uses only `fetch`, so the browser can use it
 * too.
 */

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
 * What the fetch-youtube-audio workflow
 * (.github/workflows/fetch-youtube-audio.yml) stores for a YouTube video,
 * since YouTube blocks yt-dlp from datacenter IPs (CI, servers). Keep the
 * keys in step with the workflow.
 *
 * Keyed by video ID, so a video edited in place on YouTube (trimmed, or audio
 * muted over a copyright claim) keeps its old audio there. That's rare for
 * meetings, and the golden fixtures' sha256 checks would catch it.
 */
export interface YoutubeVideoFiles {
  /** yt-dlp's info JSON for the video (minus its stream URLs). */
  infoJson: BlobFile;
  /**
   * YouTube's Opus audio re-encoded to 16 kHz mono Opus in WebM at 24 kbps
   * (~11 MB per hour), plenty for the models, which take 16 kHz mono.
   */
  speechWebm: BlobFile;
  /** What the workflow writes instead when it fails. */
  errorJson: BlobFile;
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
        infoJson: file(`${prefix}/info.json`),
        speechWebm: file(`${prefix}/speech.webm`),
        errorJson: file(`${prefix}/error.json`),
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
