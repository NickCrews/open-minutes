# @open-minutes/youtube

Where Open Minutes gets meetings published on YouTube. It implements
`@open-minutes/core`'s `RecordingLister` for a channel or playlist (`youtubeSource`:
the videos in it) and `AudioProvider` for a video (`youtube`: its metadata, and
its original Opus-in-WebM audio). `metadataFromYtDlpInfo` reads yt-dlp's info
JSON, which `@open-minutes/meeting-audio` also uses on the copies in the blob store
([`@open-minutes/blobstore`](../blobstore/README.md)).

Metadata and audio come from yt-dlp, which runs through
[`@open-minutes/ytdlp`](../ytdlp/README.md), which installs it and, for a
video's metadata and audio, routes it through WARP or Tor when YouTube
refuses a direct request. Listing a channel or playlist always goes direct,
since that works from any IP. The audio is saved as YouTube serves it;
[`@open-minutes/codecs`](../codecs/README.md) decodes it, with no ffmpeg. See
`youtubeConfigFromEnv` for the environment variables it reads.

## The `youtube` CLI

```sh
pnpm exec youtube fetch <video id or URL> <dir> [--routes <routes>] [--no-install] [--debs <dir>]
```

Calls `fetchVideo`, which writes the video's original audio to
`<dir>/audio.webm` and yt-dlp's metadata to `<dir>/info.json` (without the
stream URLs, which expire within hours), from one yt-dlp request. It goes
direct first. If YouTube refuses, it moves on to WARP, then Tor, installing
them first on Linux with apt and sudo (`--no-install` skips that), and stops
them when done. `--debs` keeps their .deb files somewhere a workflow can
cache. On failure it exits 1, and `<dir>/logs/last-error.txt` says why,
beside WARP's and Tor's logs. The
[`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
workflow runs it.
