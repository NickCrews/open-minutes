# @open-minutes/youtube

Where Open Minutes gets meetings published on YouTube. It implements
`@open-minutes/core`'s `VideoLister` for a channel or playlist URL (the videos
on it) and `AudioProvider` for a video (its metadata, and its audio as 16 kHz
mono WAV).
It knows nothing about the database or what happens to the audio next;
`@open-minutes/pipeline` does that.

Metadata and audio come from yt-dlp, or, where YouTube blocks yt-dlp (CI,
servers), from the project's object store, which the
[`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
workflow fills. YouTube's Opus audio is decoded to WAV here with libopus
compiled to WebAssembly (`opus-decoder`), so no ffmpeg is needed. See
`youtubeFromEnv` for the environment variables it reads.
