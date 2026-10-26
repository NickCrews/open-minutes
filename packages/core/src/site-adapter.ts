import type { Site } from "./site";

export type { Site } from "./site";

/**
 * A site recordings are published on, as the pipeline sees it: a recording's
 * metadata and audio, by its ID on the site. Each site implements this (see
 * @open-minutes/youtube and @open-minutes/akleg), so the pipeline can take one
 * without caring which, and tests can pass a fake (see the pipeline's
 * `om/testing.ts`). Listing a source's recordings is `RecordingLister`'s job
 * (see ./recording-lister).
 */
export interface SiteAdapter {
  readonly site: Site;
  /** The recording's title, publisher and so on. */
  getMetadata(recordingIdOrUrl: string): Promise<RecordingMetadata>;
  /** The extension of the files {@link ensureAudioDownloaded} saves, for naming them. */
  readonly audioExtension: "mp3" | "webm";
  /**
   * Makes sure `path` holds the recording's audio, as the site serves it
   * (WebM/Opus for YouTube, MP3 for akleg.gov), undecoded. `ensureWaveAudio`
   * in `@open-minutes/audio/wav` decodes it for the models. An existing file
   * at `path` is kept unless `overwrite` is set. An interrupted download
   * never leaves a partial file at `path`. Returns whether it downloaded
   * anything.
   */
  ensureAudioDownloaded(
    recordingIdOrUrl: string,
    path: string,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<{ downloaded: boolean }>;
}

export interface RecordingMetadata {
  /** The recording's ID on its site. */
  id: string;
  /** The recording's page on its site, for people. */
  permalink: string;
  /** The channel the recording was published on (eg "UCOUlNInprZEjhbpVPiJOlEA"). */
  channelId: string;
  title: string;
  description: string;
  durationSecs: number | null;
  /**
   * When the site published the recording, or null if it doesn't say. A
   * meeting happens on or before it.
   */
  publishedAt: Date | null;
}
