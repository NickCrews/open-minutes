/**
 * Minimal typings for the parts of the YouTube IFrame Player API we use.
 * https://developers.google.com/youtube/iframe_api_reference
 */
export interface YTPlayer {
  getCurrentTime(): number;
  /** Total length in seconds, or 0 until the video's metadata has loaded. */
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(args: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  setPlaybackRate(rate: number): void;
  destroy(): void;
}

/** Playback rates the IFrame API accepts, slowest first. */
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** The subset of YT.PlayerState values we care about. */
export const PlayerState = { ended: 0, playing: 1, paused: 2 } as const;

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: { events?: PlayerEvents },
  ) => YTPlayer;
}

interface PlayerEvents {
  onReady?: () => void;
  onStateChange?: (event: { data: number }) => void;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | undefined;

/**
 * Load the YouTube IFrame Player API, reusing one script tag across calls.
 * Client-only: call from onMount.
 */
export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  apiPromise ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return apiPromise;
}

/**
 * Create a YouTube player inside `host`, resolving once the player is ready.
 *
 * The iframe is created here, pointed at the embed URL, and handed to the API
 * only after it has loaded. Left to build its own iframe, the API messages it
 * while it is still about:blank, and the browser logs a "Failed to execute
 * 'postMessage'" origin-mismatch warning for every message sent too early.
 * Client-only: call from onMount or an event handler.
 */
export function createYouTubePlayer(
  host: HTMLElement,
  options: {
    videoId: string;
    playerVars?: Record<string, string | number>;
    onStateChange?: PlayerEvents["onStateChange"];
  },
): Promise<YTPlayer> {
  const params = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(options.playerVars ?? {}).map(([k, v]) => [k, String(v)]),
    ),
    enablejsapi: "1",
    origin: window.location.origin,
  });
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(options.videoId)}?${params}`;
  iframe.allow =
    "autoplay; encrypted-media; fullscreen; picture-in-picture; web-share";
  iframe.allowFullscreen = true;
  // YouTube refuses embeds that send no Referer.
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.title = "YouTube video player";
  const loaded = new Promise((resolve) =>
    iframe.addEventListener("load", resolve, { once: true }),
  );
  host.appendChild(iframe);
  return Promise.all([loadYouTubeIframeApi(), loaded]).then(
    ([YT]) =>
      new Promise<YTPlayer>((resolve) => {
        const player: YTPlayer = new YT.Player(iframe, {
          events: {
            onReady: () => resolve(player),
            onStateChange: options.onStateChange,
          },
        });
      }),
  );
}
