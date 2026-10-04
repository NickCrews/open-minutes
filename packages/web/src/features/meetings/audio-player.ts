/** Where a player's playhead is, and whether it's moving. */
export type Playhead = { secs: number; moving: boolean };

/**
 * One way of playing a meeting's audio, invisibly. `createHiddenPlayer`
 * chooses between them (see `stored-audio-player` and `youtube-audio-player`).
 *
 * A player holds one video at a time, named by its YouTube ID, and makes its
 * element or embed lazily, on the first `load` or `play`, so it's free to
 * create one during SSR.
 */
export interface AudioPlayer {
  /** Starts loading `youtubeId`, so a later `play` of it starts sooner. */
  load(youtubeId: string): void;
  /** Plays `youtubeId` from `secs`, loading it first if need be. */
  play(youtubeId: string, secs: number): void;
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
