# @open-minutes/meeting-audio

Gets a meeting's audio. Two parts:

- `storedYoutube` (and `storedYoutubeFromEnv`): an `AudioProvider` for YouTube
  that reads a video's metadata and audio from the blob store, where the
  [`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
  workflow puts them, so it works where YouTube blocks yt-dlp (CI, servers).
  On a miss it triggers that workflow and waits, given
  `YOUTUBE_AUDIO_DISPATCH_TOKEN`, or else falls back to
  [`@open-minutes/youtube`](../youtube/README.md). `@open-minutes/ingest` uses
  it as its YouTube site. Where the store keeps a video's files is
  `blobStore().youtube()` in [`@open-minutes/blobstore`](../blobstore/README.md).
- `getCachedAudio`: a YouTube video's audio decoded to 16 kHz mono WAV (by
  [`@open-minutes/codecs`](../codecs/README.md)) in the per-machine cache,
  `~/.cache/open-minutes/meetings/<youtubeId>/`, downloaded through
  `storedYoutubeFromEnv` on first use, and optionally checked against an
  expected sha256. The audio tools in `@open-minutes/agents` read meetings'
  audio from here, as does `getMeetingAudio` in `@open-minutes/fixtures/audio`,
  which checks a golden meeting's audio against its `_audio_sha256` for the
  slow tests.

It doesn't depend on `@open-minutes/audio` or `@open-minutes/fixtures`, so
both can use it.
