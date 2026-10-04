import { createYouTubeController } from "~/lib/youtube";
import type { AudioPlayer, AudioPlayerEvents } from "./audio-player";

/**
 * Makes players for YouTube videos' audio, all sharing one embed in
 * `host()`, which the page keeps out of sight. The embed takes a few seconds
 * to make, so one is made once, by the first `load` or `play`, and then
 * switches videos.
 *
 * A player's events and playhead are its own only while it holds the embed:
 * from its `play` until another player's.
 */
export function createYouTubeAudioPlayers(options: {
  host: () => HTMLElement | undefined;
}) {
  /** The player holding the embed, and its events. */
  let owner: { player: AudioPlayer; events: AudioPlayerEvents } | null = null;

  const controller = createYouTubeController({
    host: options.host,
    onStateChange: (state) => {
      if (state === "playing") owner?.events.onPlayingChange(true);
      else if (state === "paused" || state === "ended")
        owner?.events.onPlayingChange(false);
    },
  });

  /** A player for `youtubeId`'s audio. */
  const player = (
    options: AudioPlayerEvents & { youtubeId: string },
  ): AudioPlayer => {
    const { youtubeId } = options;
    const self: AudioPlayer = {
      // Makes the embed, cued to this video unless it's made already.
      load: () => void controller.load(youtubeId),
      play(secs) {
        if (owner && owner.player !== self) {
          owner.events.onPlayingChange(false);
        }
        owner = { player: self, events: options };
        void controller.play({ videoId: youtubeId, secs });
      },
      pause() {
        if (owner?.player === self) controller.pause();
      },
      playhead() {
        if (owner?.player !== self) return null;
        const tick = controller.tick();
        // Unstarted or cued, it reports 0 rather than where it will start.
        if (!tick || tick.state === "unstarted" || tick.state === "cued") {
          return null;
        }
        return { secs: tick.secs, moving: tick.state === "playing" };
      },
      destroy() {
        if (owner?.player !== self) return;
        controller.pause();
        owner = null;
      },
    };
    return self;
  };

  return { player, destroy: () => controller.destroy() };
}
