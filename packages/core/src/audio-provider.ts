/**
 * A site meetings are published on (YouTube today), as the pipeline sees it:
 * what a video is, and its audio. Each site implements this (see
 * @open-minutes/youtube), so the pipeline can take one without caring which,
 * and tests can pass a fake (see the pipeline's `om/testing.ts`). Listing a
 * site's videos is `VideoLister`'s job (see ./video-lister).
 */
export interface AudioProvider {
  /** The video's title, publisher and so on. */
  getMetadata(videoIdOrUrl: string): Promise<VideoMetadata>;
  /**
   * Makes sure `path` holds the video's audio as 16 kHz mono WAV, which is
   * what the transcription model wants. An existing file at `path` is kept
   * unless `overwrite` is set. Returns whether it downloaded anything.
   */
  ensureAudioDownloaded(
    videoIdOrUrl: string,
    path: string,
    options?: { overwrite?: boolean },
  ): Promise<{ downloaded: boolean }>;
}

export interface VideoMetadata {
  id: string;
  /** The channel the video was published on (eg "UCOUlNInprZEjhbpVPiJOlEA"). */
  channelId: string;
  title: string;
  description: string;
  durationSecs: number | null;
  /**
   * The day the video was published, "YYYY-MM-DD" (UTC), or null if unknown.
   * A meeting happens on or before it.
   */
  uploadDate: string | null;
}
