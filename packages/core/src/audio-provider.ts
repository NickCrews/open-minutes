/**
 * A site meetings are published on (YouTube today), as the pipeline sees it:
 * what a recording is, and its audio. Each site implements this (see
 * @open-minutes/youtube), so the pipeline can take one without caring which,
 * and tests can pass a fake (see the pipeline's `om/testing.ts`). Listing a
 * site's recordings is `RecordingLister`'s job (see ./recording-lister).
 */
export interface AudioProvider {
  /** The recording's title, publisher and so on. */
  getMetadata(recordingIdOrUrl: string): Promise<RecordingMetadata>;
  /**
   * Makes sure `path` holds the recording's audio as 16 kHz mono WAV, which is
   * what the transcription model wants. An existing file at `path` is kept
   * unless `overwrite` is set. Returns whether it downloaded anything.
   */
  ensureAudioDownloaded(
    recordingIdOrUrl: string,
    path: string,
    options?: { overwrite?: boolean },
  ): Promise<{ downloaded: boolean }>;
}

export interface RecordingMetadata {
  id: string;
  /** The channel the recording was published on (eg "UCOUlNInprZEjhbpVPiJOlEA"). */
  channelId: string;
  title: string;
  description: string;
  durationSecs: number | null;
  /**
   * The day the recording was published, "YYYY-MM-DD" (UTC), or null if unknown.
   * A meeting happens on or before it.
   */
  uploadDate: string | null;
}
