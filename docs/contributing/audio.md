# Meeting audio

How a meeting's audio gets from the site that published it to the speech
models.

## Getting the audio

Each source package fetches the audio its site serves: the YouTube source uses
yt-dlp, and the Alaska Legislature source downloads akleg.gov's MP3s directly.

YouTube blocks yt-dlp from servers and CI runners ("sign in to confirm you're
not a bot"), so YouTube audio is also kept in the project's blob store, a
public Cloudflare R2 bucket. A GitHub Actions workflow downloads a video
through Cloudflare WARP or Tor, re-encodes its audio to small, low-bitrate
Opus, and stores it there along with yt-dlp's metadata. Code that needs a
video reads it from the store first. On a miss it can trigger that workflow
and wait (given a GitHub token), or fall back to running yt-dlp locally, which
works from a home connection. [`.env.example`](../../.env.example) lists the
settings, and [youtube-on-servers.md](../research/youtube-on-servers.md) explains how
the workaround was chosen.

yt-dlp is installed into the repo's cache the first time it's needed, if it
isn't already on your `PATH`.

## Decoding and caching

The models want 16 kHz mono WAV. Opus and MP3 are decoded in WebAssembly, so
nothing needs ffmpeg. Decoded audio is cached per machine, so each meeting is
downloaded and decoded once.

## Speech models

Transcription, voice activity detection, diarization and voiceprints all run
locally on CPU with ONNX models, with no GPU or external API. The models
(about 650 MB) are downloaded the first time each is used, or all at once with
`pnpm models`. `pnpm bench` times them on a minute of real meeting audio, so a
model change shows what it costs.

The golden meetings in the test data are scored against these models by the
slow tests; see [testing.md](testing.md).

## Where to look

- [`packages/youtube`](../../packages/youtube/README.md),
  [`packages/akleg`](../../packages/akleg/README.md) and
  [`packages/ytdlp`](../../packages/ytdlp/README.md): the sources.
- [`packages/blobstore`](../../packages/blobstore/README.md): what the bucket
  holds.
- [`packages/meeting-audio`](../../packages/meeting-audio/README.md): reading
  from the store, and the per-machine cache.
- [`packages/codecs`](../../packages/codecs/README.md): decoding.
- [`packages/audio`](../../packages/audio/README.md): the speech models.
