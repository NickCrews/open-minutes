# @open-minutes/youtube

Where Open Minutes gets meetings published on YouTube. It implements
`@open-minutes/core`'s `RecordingLister` for a channel or playlist (`youtubeSource`:
the videos in it) and `AudioProvider` for a video (`youtube`: its metadata, and
its audio as 16 kHz mono WAV).
It knows nothing about the database or what happens to the audio next;
`@open-minutes/ingest` does that.

Metadata and audio come from yt-dlp, or, where YouTube blocks yt-dlp (CI,
servers), from the project's object store, which the
[`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
workflow fills. yt-dlp runs through
[`@open-minutes/ytdlp`](../ytdlp/README.md), which installs it and, for a
video's metadata and audio, routes it through WARP or Tor when YouTube
refuses a direct request. Listing a channel or playlist always goes direct,
since that works from any IP. YouTube's Opus audio is decoded to WAV here with
libopus compiled to WebAssembly (`opus-decoder`), so no ffmpeg is needed. See
`youtubeConfigFromEnv` for the environment variables it reads.
