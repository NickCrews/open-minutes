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
  /**
   * The recording's ID on the site, from either an ID or a URL to it: a
   * YouTube video ID, or an akleg.gov meeting ID. The other methods take
   * either form; this gives the one to key stored files by.
   */
  recordingId(recordingIdOrUrl: string): string;
  /** The recording's title, publisher and so on. */
  getMetadata(recordingIdOrUrl: string): Promise<RecordingMetadata>;
  /**
   * Downloads the recording's audio to `path` encoded for speech, whatever
   * format the site serves: 16 kHz mono Opus in WebM at 24 kbps (see
   * `encodeSpeechWebm` in @open-minutes/codecs). Replaces any file there. An
   * interrupted download never leaves a partial file. Caching is the caller's
   * job.
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
 * `metadata` as JSON, the way the blob store and the fetch-youtube-audio
 * workflow keep it: `publishedAt` is an ISO 8601 string.
 */
export function metadataToJson(
  metadata: RecordingMetadata,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`);
}

/** The {@link RecordingMetadata} in JSON from {@link metadataToJson}. */
export function metadataFromJson(json: Uint8Array): RecordingMetadata {
  const raw = JSON.parse(new TextDecoder().decode(json)) as Omit<
    RecordingMetadata,
    "publishedAt"
  > & { publishedAt: string | null };
  return {
    ...raw,
    publishedAt: raw.publishedAt === null ? null : new Date(raw.publishedAt),
  };
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
