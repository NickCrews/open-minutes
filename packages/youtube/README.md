# @open-minutes/youtube

Where Open Minutes gets meetings published on YouTube. It implements
`@open-minutes/core`'s `VideoLister` for a channel or playlist (`youtubeSource`:
the videos in it) and `AudioProvider` for a video (`youtube`: its metadata, and
its audio as 16 kHz mono WAV).
It knows nothing about the database or what happens to the audio next;
`@open-minutes/ingest` does that.

Metadata and audio come from yt-dlp, or, where YouTube blocks yt-dlp (CI,
servers), from the project's object store, which the
[`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
workflow fills. YouTube's Opus audio is decoded to WAV here with libopus
compiled to WebAssembly (`opus-decoder`), so no ffmpeg is needed. See
`youtubeConfigFromEnv` for the environment variables it reads.

## Proxies

Where YouTube blocks yt-dlp and there's no `YOUTUBE_AUDIO_DISPATCH_TOKEN`,
yt-dlp can go out through Tor or Cloudflare WARP. Run Tor
(`brew install tor && tor`, or `apt install tor`) or WARP in proxy mode, and
set `YOUTUBE_PROXY` to their SOCKS URLs, comma-separated:

```sh
export YOUTUBE_PROXY=socks5://127.0.0.1:40000,socks5://127.0.0.1:9050
```

A video's metadata and audio are fetched through each in turn until one gets
past YouTube's bot check; listing a channel or playlist always goes direct,
since that works from any IP. Use `socks5://`, not `socks5h://`: IPv4 exits
got through more often (see
[docs/research/youtube-in-ci.md](../../docs/research/youtube-in-ci.md)).
Sandboxed containers whose only egress is an HTTPS proxy can run neither
(WARP needs UDP, Tor arbitrary TCP ports); they need the dispatch token.
