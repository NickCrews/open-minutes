/** Where a player's playhead is, and whether it's moving. */
export type Playhead = { secs: number; moving: boolean };

/**
 * One meeting's audio, from one source, played invisibly. A player is made
 * for its source (see `stored-audio-player` and `youtube-audio-player`), and
 * `createHiddenPlayer` chooses which to make for each meeting.
 *
 * It makes its element or embed lazily, on the first `load` or `play`, so
 * it's free to create one during SSR.
 */
export interface AudioPlayer {
  /** Starts loading, so a later `play` starts sooner. */
  load(): void;
  /** Plays from `secs`, loading first if need be. */
  play(secs: number): void;
  pause(): void;
  /**
   * The playhead, or null while the player can't say where it is (nothing
   * loaded yet, or still starting up).
   */
  playhead(): Playhead | null;
  destroy(): void;
}

export type AudioPlayerEvents = {
  /** It started or stopped playing, by itself or because it was told to. */
  onPlayingChange: (playing: boolean) => void;
};
