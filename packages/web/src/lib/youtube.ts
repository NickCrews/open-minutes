/** Where a YouTube player is in playing its video. */
export type PlayerState =
  | "unstarted"
  | "ended"
  | "playing"
  | "paused"
  | "buffering"
  | "cued";

/** Playback rates the IFrame API accepts, slowest first. */
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * Minimal typings for the parts of the YouTube IFrame Player API we use.
 * https://developers.google.com/youtube/iframe_api_reference
 */
interface RawPlayer {
  getCurrentTime(): number;
  /** A YT.PlayerState code; see {@link toPlayerState}. */
  getPlayerState(): number;
  /** Total length in seconds, or 0 until the video's metadata has loaded. */
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(args: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  setPlaybackRate(rate: number): void;
  destroy(): void;
}

/** The IFrame API's YT.PlayerState codes, by name. */
const PLAYER_STATES: Record<number, PlayerState> = {
  [-1]: "unstarted",
  0: "ended",
  1: "playing",
  2: "paused",
  3: "buffering",
  5: "cued",
};

/** A YT.PlayerState code as a {@link PlayerState}. */
function toPlayerState(code: number): PlayerState {
  // The API documents no other codes; nothing has played if one appears.
  return PLAYER_STATES[code] ?? "unstarted";
}

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: { events?: PlayerEvents },
  ) => RawPlayer;
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
function loadYouTubeIframeApi(): Promise<YTNamespace> {
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
 * Creates a YouTube player inside `host`, resolving once the player is ready.
 *
 * The iframe is created here, pointed at the embed URL, and handed to the API
 * only after it has loaded. Left to build its own iframe, the API messages it
 * while it is still about:blank, and the browser logs a "Failed to execute
 * 'postMessage'" origin-mismatch warning for every message sent too early.
 * Client-only: call from onMount or an event handler.
 */
function createRawPlayer(
  host: HTMLElement,
  options: {
    videoId: string;
    playerVars?: Record<string, string | number>;
    onStateChange?: PlayerEvents["onStateChange"];
  },
): Promise<RawPlayer> {
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
      new Promise<RawPlayer>((resolve) => {
        const player: RawPlayer = new YT.Player(iframe, {
          events: {
            onReady: () => resolve(player),
            onStateChange: options.onStateChange,
          },
        });
      }),
  );
}

/** A YouTube player's playback at one moment. */
export type Tick = {
  secs: number;
  state: PlayerState;
  /** Total length in seconds, or 0 until the video's metadata has loaded. */
  duration: number;
};

/**
 * A YouTube player, made in a host element of the caller's: the meeting
 * page's visible video, or the hidden one that plays excerpts' audio. Whether
 * anyone sees it is up to the host's styling.
 */
export interface YouTubeController {
  /**
   * Makes the embed with `videoId` cued, unless it's made already. Resolves
   * to whether it's ready (false if there's no host yet, or it was destroyed
   * first).
   */
  load(videoId: string): Promise<boolean>;
  /**
   * Plays `videoId` (by default, the video loaded) from `secs` (by default,
   * where it is), making the embed first if need be. A play still waiting on
   * the embed is dropped if another play or a pause comes first.
   */
  play(options?: { videoId?: string; secs?: number }): Promise<void>;
  pause(): void;
  /** `allowSeekAhead` false fetches nothing new: for while a scrub is live. */
  seekTo(secs: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  /** Its playback now, or null until the embed is ready. */
  tick(): Tick | null;
  destroy(): void;
}

/**
 * Makes a {@link YouTubeController}. Nothing happens until the first `load`
 * or `play`, so it's free to make during SSR.
 *
 * `onTick` is called with the playback every quarter second once the embed
 * is ready: the IFrame API has no timeupdate event, so this is how a caller
 * follows the playhead (including the reader clicking around YouTube's own
 * timeline).
 */
export function createYouTubeController(options: {
  host: () => HTMLElement | undefined;
  onStateChange?: (state: PlayerState) => void;
  onTick?: (tick: Tick) => void;
}): YouTubeController {
  let embed: Promise<RawPlayer | undefined> | undefined;
  let player: RawPlayer | undefined;
  /** The video loaded into the embed. */
  let loaded: string | null = null;
  /** The latest play asked for; see `play`. */
  let request: object | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;

  const tick = (): Tick | null => {
    const secs = player?.getCurrentTime?.();
    if (!player || typeof secs !== "number" || Number.isNaN(secs)) return null;
    return {
      secs,
      state: toPlayerState(player.getPlayerState()),
      duration: player.getDuration?.() || 0,
    };
  };

  // Never `autoplay`: autoplaying a newly made embed can stall back to
  // unstarted, with nothing played. It's made cued, and `play` starts it.
  const ready = (videoId: string) => {
    if (embed) return embed;
    const host = options.host();
    if (!host) return Promise.resolve(undefined);
    loaded = videoId;
    embed = createRawPlayer(host, {
      videoId,
      playerVars: { playsinline: 1 },
      onStateChange: ({ data }) => options.onStateChange?.(toPlayerState(data)),
    }).then((created) => {
      if (destroyed) {
        created.destroy();
        return undefined;
      }
      player = created;
      const onTick = options.onTick;
      if (onTick) {
        poll = setInterval(() => {
          const now = tick();
          if (now) onTick(now);
        }, 250);
      }
      return created;
    });
    return embed;
  };

  return {
    load: async (videoId) => (await ready(videoId)) !== undefined,
    async play({ videoId = loaded ?? undefined, secs } = {}) {
      if (!videoId) return;
      const mine = {};
      request = mine;
      const embedded = await ready(videoId);
      if (!embedded || destroyed || request !== mine) return;
      if (loaded === videoId) {
        if (secs !== undefined) embedded.seekTo(secs, true);
        embedded.playVideo();
      } else {
        loaded = videoId;
        embedded.loadVideoById({ videoId, startSeconds: secs });
      }
    },
    pause() {
      request = null;
      player?.pauseVideo();
    },
    seekTo: (secs, allowSeekAhead) => player?.seekTo(secs, allowSeekAhead),
    setPlaybackRate: (rate) => player?.setPlaybackRate(rate),
    tick,
    destroy() {
      destroyed = true;
      clearInterval(poll);
      player?.destroy();
    },
  };
}
