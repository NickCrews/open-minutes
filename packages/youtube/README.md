# @open-minutes/youtube

Where Open Minutes gets meetings published on YouTube. It implements
`@open-minutes/core`'s `RecordingLister` for a channel or playlist (`youtubeSource`:
the videos in it) and `AudioProvider` for a video (`youtube`: its metadata, and
its original Opus-in-WebM audio). `metadataFromYtDlpInfo` reads yt-dlp's info
JSON, which `@open-minutes/ingest` also uses on the copies in the blob store
([`@open-minutes/blobstore`](../blobstore/README.md)).

Metadata and audio come from yt-dlp, which runs through
[`@open-minutes/ytdlp`](../ytdlp/README.md), which installs it and, for a
video's metadata and audio, routes it through WARP or Tor when YouTube
refuses a direct request. Listing a channel or playlist always goes direct,
since that works from any IP. The audio is saved as YouTube serves it;
[`@open-minutes/codecs`](../codecs/README.md) decodes it, with no ffmpeg. See
`youtubeConfigFromEnv` for the environment variables it reads.
