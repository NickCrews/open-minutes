/**
 * The sites recordings are published on. A recording's ID on its site is a
 * YouTube video ID, or an akleg.gov meeting ID ("HRES 2018-09-10 14:00:00").
 */
export const SITES = ["youtube", "akleg"] as const;
export type Site = (typeof SITES)[number];

/**
 * A recording's metadata and audio, by its ID on a site. @open-minutes/youtube
 * and @open-minutes/akleg each implement it. Listing a meeting source's
 * recordings is `RecordingLister`'s job.
 */
export interface SiteAdapter {
  readonly site: Site;
  /** The recording's title, publisher and so on. */
  getMetadata(recordingIdOrUrl: string): Promise<RecordingMetadata>;
  /** The extension of the files {@link downloadAudio} saves, for naming them. */
  readonly audioExtension: "mp3" | "webm";
  /**
   * Downloads the recording's audio to `path`, undecoded, in the site's format
   * (WebM/Opus for YouTube, MP3 for akleg.gov), replacing any file there. An
   * interrupted download never leaves a partial file. Caching is the caller's job.
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

/**
 * The recordings a meeting source lists, on any site. Each site has a
 * constructor for one, such as @open-minutes/youtube's `youtubeSource`.
 */
export interface RecordingLister {
  /** The source's recordings, newest first, without duplicates. */
  listRecordings(): Promise<ListedRecording[]>;
}

export interface ListedRecording {
  /** The recording's ID on its site, as its `SiteAdapter` takes it. */
  id: string;
  title?: string;
}
