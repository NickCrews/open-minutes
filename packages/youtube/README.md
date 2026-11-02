# @open-minutes/youtube

Where Open Minutes gets meetings published on YouTube. It implements
`@open-minutes/core`'s `RecordingLister` for a channel or playlist (`youtubeSource`:
the videos in it) and `SiteAdapter` for a video (`youtube`: its metadata, and
its audio). Each lives in its own file, named after the interface. `core.ts`
holds the helpers that `@open-minutes/meeting-audio` also uses: `videoId`,
`metadataToJson` and `metadataFromJson`, the form the blob store
([`@open-minutes/blobstore`](../blobstore/README.md)) and the workflow below
keep metadata in, and `metadataFromYtDlpInfo`, which reads yt-dlp's info JSON.

`youtube()` gets each video the first way that works:

1. yt-dlp through `runWithEgress` in
   [`@open-minutes/ytdlp`](../ytdlp/README.md): direct, then WARP, then Tor
   (or the `routes` option, else the routes in `YOUTUBE_EGRESS`). Direct
   works from a home connection. With the `installEgress` option, WARP and
   Tor are installed first if a route needs them.
   The audio is YouTube's smallest Opus format (249, ~50 kbps, ~22 MB per
   hour).
2. `fetchVideoViaWorkflow`, when YouTube refuses every route and
   `YOUTUBE_AUDIO_DISPATCH_TOKEN` is set. It runs the
   [`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
   workflow, which fetches the video through WARP or Tor on a GitHub runner,
   waits for it, and downloads the files the run published as artifacts. The
   workflow runs `youtube()` itself (through the CLI below), so it gives the
   same files.

Either way, the audio is re-encoded for speech (`encodeSpeechWebm` in
[`@open-minutes/codecs`](../codecs/README.md): 16 kHz mono Opus in WebM at
24 kbps, ~11 MB per hour), with no ffmpeg.

Any other error, such as a private or removed video, is thrown at once.
Listing a channel or playlist always goes direct, since that works from any
IP.

This package does not deal with caching, it always fetches from youtube via one way or another.

## The `youtube` CLI

```sh
pnpm exec youtube fetch <video id or URL> <dir> [--routes <routes>] [--no-install] [--debs <dir>]
```

Runs `youtube()` and writes the video's `RecordingMetadata` to
`<dir>/metadata.json` (as `metadataToJson` writes it) and its audio,
re-encoded for speech, to `<dir>/speech.webm`. It goes direct first. If
YouTube refuses, it moves on to WARP, then Tor, installing them first on Linux
with apt and sudo (`--no-install` skips that), and stops them when done.
`--debs` keeps their .deb files somewhere a workflow can cache. On failure it
exits 1, and `<dir>/logs/last-error.txt` says why, beside WARP's and Tor's
logs. The
[`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
workflow runs it.
