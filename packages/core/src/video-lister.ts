/**
 * A site meetings are published on (a YouTube channel, a Vimeo showcase, a
 * legislature's video archive...), as `om available` sees it: the videos
 * listed at a URL. Each site implements this (see @open-minutes/youtube), so
 * discovering new meetings doesn't care which, and tests can pass a fake (see
 * the pipeline's `om/testing.ts`). Getting a listed video's metadata and audio
 * is `AudioProvider`'s job (see ./audio-provider).
 */
export interface VideoLister {
  /**
   * The videos listed at `sourceUrl` (a body's video source, eg a channel or
   * playlist), newest first, without duplicates.
   */
  listVideos(sourceUrl: string): Promise<ListedVideo[]>;
}

export interface ListedVideo {
  /** The site's ID for the video, as its `AudioProvider` takes it. */
  id: string;
  title?: string;
}
