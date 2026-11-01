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
