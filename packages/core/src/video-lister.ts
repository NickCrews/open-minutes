/**
 * One of a body's video sources on some site (a YouTube channel or playlist, a
 * Vimeo showcase, a legislature's video archive...), as `om available` sees
 * it: the videos it lists. Each site has its own constructor taking whatever
 * identifies a source there (see @open-minutes/youtube's `youtubeSource`), so
 * discovering new meetings doesn't care which site, and tests can pass a fake.
 * Getting a listed video's metadata and audio is `AudioProvider`'s job (see
 * ./audio-provider).
 */
export interface VideoLister {
  /** The source's videos, newest first, without duplicates. */
  listVideos(): Promise<ListedVideo[]>;
}

export interface ListedVideo {
  /** The site's ID for the video, as its `AudioProvider` takes it. */
  id: string;
  title?: string;
}
