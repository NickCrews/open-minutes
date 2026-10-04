/**
 * Where a video's files live in the object store, as
 * `youtube/<video id>/<name>`. The fetch-youtube-audio workflow
 * (.github/workflows/fetch-youtube-audio.yml) writes them there; this module
 * is how everything else finds them. It does no I/O and imports nothing, so
 * the browser can use it too.
 *
 * Keyed by video ID, so a video edited in place on YouTube (trimmed, or audio
 * muted over a copyright claim) keeps its old audio here. That's rare for
 * meetings, and the golden fixtures' sha256 checks would catch it.
 */

/** A video's files in the object store. */
export type StoredYoutubeFile =
  /** yt-dlp's metadata for the video. */
  | "info.json"
  /**
   * YouTube's Opus audio re-encoded to 16 kHz mono Opus in WebM at 24 kbps
   * (~11 MB per hour), plenty for the models, which take 16 kHz mono. It's a
   * plain file on a CDN, so an `<audio>` element plays it from any point after
   * a couple of small range requests.
   */
  | "speech.webm"
  /** Written instead when the workflow fails, so clients stop waiting. */
  | "error.json";

/** The key of `youtubeId`'s `name` file in the object store. */
export function storedYoutubeKey(youtubeId: string, name: StoredYoutubeFile) {
  return `youtube/${encodeURIComponent(youtubeId)}/${name}`;
}

/**
 * The public URL of `youtubeId`'s `name` file, in the object store at `base`
 * (its public URL, OBJECT_STORE_PUBLIC_URL).
 */
export function storedYoutubeFileUrl(
  base: string,
  youtubeId: string,
  name: StoredYoutubeFile,
) {
  return `${base.replace(/\/$/, "")}/${storedYoutubeKey(youtubeId, name)}`;
}

/** The public URL of `youtubeId`'s speech audio; see {@link StoredYoutubeFile}. */
export function storedYoutubeAudioUrl(base: string, youtubeId: string) {
  return storedYoutubeFileUrl(base, youtubeId, "speech.webm");
}
