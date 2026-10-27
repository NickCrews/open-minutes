# @open-minutes/youtube

Where Open Minutes gets meetings published on YouTube. It implements
`@open-minutes/core`'s `RecordingLister` for a channel or playlist (`youtubeSource`:
the videos in it) and `SiteAdapter` for a video (`youtube`: its metadata, and
its original Opus-in-WebM audio). Each lives in its own file, named after the
interface. `core.ts` holds the helpers that `@open-minutes/meeting-audio` also
uses: `videoId`, and `metadataFromYtDlpInfo`, which reads yt-dlp's info JSON,
including the copies in the blob store
([`@open-minutes/blobstore`](../blobstore/README.md)).

`youtube()` takes no options and gets each video the first way that works:

1. yt-dlp through `runWithEgress` in
   [`@open-minutes/ytdlp`](../ytdlp/README.md): direct, then WARP, then Tor
   (or the routes in `YOUTUBE_EGRESS`). Direct works from a home connection.
   yt-dlp's audio is saved as YouTube serves it, at ~50Mb/hour
2. `fetchVideoViaWorkflow`, when YouTube refuses every route and
   `YOUTUBE_AUDIO_DISPATCH_TOKEN` is set. It runs the
   [`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
   workflow, which fetches the video through WARP or Tor on a GitHub runner,
   waits for it, and downloads the files the run published as artifacts. Its
   audio is a speech-quality re-encode of YouTube's, still Opus in WebM.

Any other error, such as a private or removed video, is thrown at once.
Listing a channel or playlist always goes direct, since that works from any
IP.

This package does not deal with caching, it always fetches from youtube via one way or another.
