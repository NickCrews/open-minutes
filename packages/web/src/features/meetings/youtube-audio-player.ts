import { createYouTubePlayer, type YTPlayer } from "~/lib/youtube";
import type { AudioPlayer, AudioPlayerEvents } from "./audio-player";

/**
 * Plays a video's audio through a YouTube embed made inside `host()`, which
 * the page keeps out of sight. It works for any video, but the embed takes a
 * few seconds to make, so `load` makes it ahead of the first play.
 */
export function createYouTubeAudioPlayer(
  options: AudioPlayerEvents & { host: () => HTMLElement | undefined },
): AudioPlayer {
  let embed: Promise<YTPlayer> | undefined;
  let player: YTPlayer | undefined;
  /** The video loaded into the embed. */
  let loaded: string | null = null;
  /**
   * The latest play asked for. A play waiting on the embed is dropped if
   * another play or a pause comes first.
   */
  let request: object | null = null;
  let destroyed = false;

  /**
   * Makes the embed with `videoId` cued. It's started with `playVideo` once
   * ready, never `autoplay`: autoplaying a newly made embed can stall back to
   * unstarted, with nothing played.
   */
  const create = (videoId: string) => {
    const host = options.host();
    if (!host) return undefined;
    loaded = videoId;
    return createYouTubePlayer(host, {
      videoId,
      playerVars: { playsinline: 1 },
      onStateChange: (state) => {
        if (state === "playing") options.onPlayingChange(true);
        else if (state === "paused" || state === "ended")
          options.onPlayingChange(false);
      },
    }).then((created) => {
      if (destroyed) created.destroy();
      return (player = created);
    });
  };

  return {
    load(youtubeId) {
      embed ??= create(youtubeId);
    },
    async play(youtubeId, secs) {
      const mine = {};
      request = mine;
      embed ??= create(youtubeId);
      const ready = await embed;
      if (!ready || destroyed || request !== mine) return;
      if (loaded === youtubeId) {
        ready.seekTo(secs, true);
        ready.playVideo();
      } else {
        loaded = youtubeId;
        ready.loadVideoById({ videoId: youtubeId, startSeconds: secs });
      }
    },
    pause() {
      request = null;
      player?.pauseVideo();
    },
    playhead() {
      if (!player) return null;
      const state = player.getPlayerState();
      // Unstarted or cued, it reports 0 rather than where it will start.
      if (state === "unstarted" || state === "cued") return null;
      const secs = player.getCurrentTime();
      if (Number.isNaN(secs)) return null;
      return { secs, moving: state === "playing" };
    },
    destroy() {
      destroyed = true;
      player?.destroy();
    },
  };
}
