import type { AudioPlayer, AudioPlayerEvents } from "./audio-player";

/**
 * Plays a video's audio from the object store through an `<audio>` element,
 * which starts in well under a second. `urlFor` says where a video's audio is
 * (see `storedAudioUrl`).
 *
 * Not every video is in the store: when one's audio fails to load, it calls
 * `onUnavailable` with that video, and plays nothing.
 */
export function createStoredAudioPlayer(
  options: AudioPlayerEvents & {
    urlFor: (youtubeId: string) => string;
    onUnavailable: (youtubeId: string) => void;
  },
): AudioPlayer {
  let audio: HTMLAudioElement | undefined;
  /** The video whose audio `audio` holds. */
  let loaded: string | null = null;
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
      if (destroyed || !loaded) return;
      const failed = loaded;
      loaded = null;
      options.onUnavailable(failed);
    });
    return (audio = el);
  };

  const load = (youtubeId: string) => {
    const el = element();
    if (loaded !== youtubeId) {
      loaded = youtubeId;
      el.src = options.urlFor(youtubeId);
    }
    return el;
  };

  return {
    load,
    play(youtubeId, secs) {
      const el = load(youtubeId);
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
      if (!audio || !loaded) return null;
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
