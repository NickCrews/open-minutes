import { createYouTubeController } from "~/lib/youtube";
import type { AudioPlayer, AudioPlayerEvents } from "./audio-player";

/**
 * Plays a video's audio through a YouTube controller in `host()`, which the
 * page keeps out of sight. It works for any video, but the embed takes a few
 * seconds to make, so `load` makes it ahead of the first play.
 */
export function createYouTubeAudioPlayer(
  options: AudioPlayerEvents & { host: () => HTMLElement | undefined },
): AudioPlayer {
  const controller = createYouTubeController({
    host: options.host,
    onStateChange: (state) => {
      if (state === "playing") options.onPlayingChange(true);
      else if (state === "paused" || state === "ended")
        options.onPlayingChange(false);
    },
  });

  return {
    load: (youtubeId) => void controller.load(youtubeId),
    play: (youtubeId, secs) =>
      void controller.play({ videoId: youtubeId, secs }),
    pause: () => controller.pause(),
    playhead() {
      const tick = controller.tick();
      // Unstarted or cued, it reports 0 rather than where it will start.
      if (!tick || tick.state === "unstarted" || tick.state === "cued") {
        return null;
      }
      return { secs: tick.secs, moving: tick.state === "playing" };
    },
    destroy: () => controller.destroy(),
  };
}
