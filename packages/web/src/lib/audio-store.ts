/**
 * Where a meeting's audio lives in the object store (at `base`, the store's
 * public URL), or null when the store isn't configured or this browser can't
 * play it.
 *
 * The fetch-youtube-audio workflow stores each video's audio as
 * `youtube/<video id>/speech.webm`: 16 kHz mono Opus at 24 kbps, ~11 MB an
 * hour. That's a plain file on a CDN, so an `<audio>` element starts playing
 * it from any point after a couple of small range requests, much sooner than
 * a YouTube embed can load. Not every ingested video is in the store, so a
 * caller falls back to YouTube when this URL fails to load.
 */
export function storedAudioUrl(
  base: string | null,
  youtubeId: string,
): string | null {
  if (!base || !canPlayWebmOpus()) return null;
  return `${base.replace(/\/$/, "")}/youtube/${encodeURIComponent(youtubeId)}/speech.webm`;
}

let webmOpus: boolean | undefined;

/** Whether `<audio>` can play Opus in WebM (not Safari before 17, eg). */
function canPlayWebmOpus(): boolean {
  webmOpus ??=
    typeof Audio !== "undefined" &&
    new Audio().canPlayType('audio/webm; codecs="opus"') !== "";
  return webmOpus;
}
