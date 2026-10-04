import type { AudioPlayer, AudioPlayerEvents } from "./audio-player";

/**
 * Plays the audio at `url` (an object store copy; see `storedAudioUrl`)
 * through an `<audio>` element, which starts in well under a second.
 *
 * Not every video is in the store: when the audio fails to load, it calls
 * `onUnavailable`, and plays nothing.
 */
export function createStoredAudioPlayer(
  options: AudioPlayerEvents & {
    url: string;
    onUnavailable: () => void;
  },
): AudioPlayer {
  let audio: HTMLAudioElement | undefined;
  let destroyed = false;

  const element = () => {
    if (audio) return audio;
    const el = new Audio();
    // Enough to seek with; playing fetches the rest as it goes.
    el.preload = "metadata";
    el.addEventListener("playing", () => options.onPlayingChange(true));
    el.addEventListener("pause", () => options.onPlayingChange(false));
    el.addEventListener("ended", () => options.onPlayingChange(false));
    el.addEventListener("error", () => {
      if (!destroyed) options.onUnavailable();
    });
    el.src = options.url;
    return (audio = el);
  };

  return {
    load: () => void element(),
    play(secs) {
      const el = element();
      // Before the metadata loads, this sets where playback will start.
      el.currentTime = secs;
      el.play().catch((error: unknown) => {
        // A failed load is the error event's to report. This is the browser
        // refusing to play without a click, which shouldn't happen from one.
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          options.onPlayingChange(false);
        }
      });
    },
    pause: () => audio?.pause(),
    playhead() {
      if (!audio) return null;
      return {
        secs: audio.currentTime,
        moving: !audio.paused && !audio.seeking,
      };
    },
    destroy() {
      destroyed = true;
      if (!audio) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    },
  };
}
