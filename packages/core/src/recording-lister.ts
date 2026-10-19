/**
 * A body's meeting source on some site (a YouTube channel or playlist, an
 * akleg.gov committee...), as `om available` sees it: the recordings it lists.
 * Each site has its own constructor taking whatever identifies a source there (see @open-minutes/youtube's `youtubeSource`), so
 * discovering new meetings doesn't care which site, and tests can pass a fake.
 * Getting a listed recording's metadata and audio is `AudioProvider`'s job (see
 * ./audio-provider).
 */
export interface RecordingLister {
  /** The source's recordings, newest first, without duplicates. */
  listRecordings(): Promise<ListedRecording[]>;
}

export interface ListedRecording {
  /** The recording's ID on its site, as its `AudioProvider` takes it. */
  id: string;
  title?: string;
}
