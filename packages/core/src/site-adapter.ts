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
  /** The extension of the files {@link downloadAudio} saves, for naming them. */
  readonly audioExtension: "mp3" | "webm";
  /**
   * Downloads the recording's audio to `path`, in the site's format
   * (WebM/Opus for YouTube, re-encoded for speech; MP3 for akleg.gov),
   * undecoded, replacing any file there. `ensureWaveForm` in
   * `@open-minutes/codecs` decodes it for the models. An interrupted
   * download never leaves a partial file at `path`.
   * Caching is the caller's job.
   */
  downloadAudio(
    recordingIdOrUrl: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
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
