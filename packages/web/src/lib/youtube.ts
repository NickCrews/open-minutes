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
    options: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
      };
    },
  ) => YTPlayer;
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
