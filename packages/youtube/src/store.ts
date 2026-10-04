/**
 * A video's files in the object store, under `youtube/<video id>/`. The
 * fetch-youtube-audio workflow (.github/workflows/fetch-youtube-audio.yml)
 * writes them; this module is how everything else reads them. It imports
 * nothing and uses only `fetch`, so the browser can use it too.
 *
 * Keyed by video ID, so a video edited in place on YouTube (trimmed, or audio
 * muted over a copyright claim) keeps its old audio here. That's rare for
 * meetings, and the golden fixtures' sha256 checks would catch it.
 */

/**
 * The object store's public base URL: the project's Cloudflare R2 bucket.
 * Where OBJECT_STORE_PUBLIC_URL is set (the web app's wrangler.jsonc, CI), it
 * should be this.
 */
export const OBJECT_STORE_PUBLIC_URL =
  "https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev";

/** One of a video's files in the object store, whose contents are a `T`. */
export interface StoredFile<T> {
  /** Its key in the bucket, like `youtube/<video id>/speech.webm`. */
  key: string;
  /** Its public URL. */
  url: string;
  /**
   * Its contents, or null if it isn't stored. Throws on any other failure.
   * `bypassCache` gets past a CDN's cached 404, for polling until it appears.
   */
  fetch(options?: { bypassCache?: boolean }): Promise<T | null>;
}

/** The fields of yt-dlp's info JSON that the pipeline uses. */
export interface YtDlpInfo {
  id: string;
  channel_id?: string;
  title?: string;
  description?: string;
  duration?: number | null;
  /** "YYYYMMDD". */
  upload_date?: string | null;
}

/** What the workflow writes when it can't fetch a video. */
export interface FetchFailure {
  /** ISO 8601. */
  failed_at: string;
  error: string;
  /** The workflow run that failed. */
  run_url: string;
}

/** A video's files in the object store; see {@link youtubeVideoFiles}. */
export interface YoutubeVideoFiles {
  /** yt-dlp's metadata for the video (minus its stream URLs). */
  infoJson: StoredFile<YtDlpInfo>;
  /**
   * YouTube's Opus audio re-encoded to 16 kHz mono Opus in WebM at 24 kbps
   * (~11 MB per hour), plenty for the models, which take 16 kHz mono. It's a
   * plain file on a CDN, so an `<audio>` element plays it from any point after
   * a couple of small range requests.
   */
  speechWebm: StoredFile<Uint8Array>;
  /** Written instead when the workflow fails, so clients stop waiting. */
  errorJson: StoredFile<FetchFailure>;
}

/**
 * `youtubeId`'s files in the object store at `base` (by default,
 * {@link OBJECT_STORE_PUBLIC_URL}). Does no I/O until a file's `fetch`.
 */
export function youtubeVideoFiles(
  youtubeId: string,
  base: string = OBJECT_STORE_PUBLIC_URL,
): YoutubeVideoFiles {
  const file = <T>(
    name: string,
    parse: (res: Response) => Promise<T>,
  ): StoredFile<T> => {
    const key = `youtube/${encodeURIComponent(youtubeId)}/${name}`;
    const url = `${base.replace(/\/$/, "")}/${key}`;
    return {
      key,
      url,
      async fetch({ bypassCache = false } = {}) {
        const get = bypassCache ? `${url}?t=${Date.now()}` : url;
        const res = await fetch(get);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GET ${get}: HTTP ${res.status}`);
        return parse(res);
      },
    };
  };
  const json = <T>(res: Response) => res.json() as Promise<T>;
  return {
    infoJson: file("info.json", json<YtDlpInfo>),
    speechWebm: file(
      "speech.webm",
      async (res) => new Uint8Array(await res.arrayBuffer()),
    ),
    errorJson: file("error.json", json<FetchFailure>),
  };
}
