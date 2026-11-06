# @open-minutes/meeting-audio

Gets a meeting's audio. Two parts:

- `storedSite` (and `storedSiteFromEnv`): wraps a site's `SiteAdapter`
  (`youtube()` in [`@open-minutes/youtube`](../youtube/README.md), or
  `akleg()` in [`@open-minutes/akleg`](../akleg/README.md)) so it reads a
  recording's metadata and audio from the blob store first. That makes
  YouTube work where it blocks yt-dlp (CI, servers). On a miss it gets them
  from the site; given the blob store's keys, it stores both there. The audio
  is what the site's adapter gives: the site's audio encoded for speech
  (16 kHz mono Opus in WebM). Where the store keeps a recording's files is
  `blobStore().recording()` in [`@open-minutes/blobstore`](../blobstore/README.md).
- `getCachedAudio`: a recording's audio decoded to 16 kHz mono WAV (by
  [`@open-minutes/codecs`](../codecs/README.md)) in the per-machine cache,
  `~/.cache/open-minutes/meetings/<site>/<id>/` (the ID as
  `recordingDir` in `@open-minutes/blobstore` writes it), downloaded through
  `storedSiteFromEnv` on first use, and optionally checked against an
  expected sha256. `getMeetingAudio` in `@open-minutes/datasets/audio` reads
  meetings' audio from here, and checks a golden meeting's audio against its
  `_audio_sha256` for the slow tests.

It doesn't depend on `@open-minutes/audio-ml` or `@open-minutes/datasets`, so
both can use it.
