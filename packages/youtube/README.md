# @open-minutes/youtube

Where Open Minutes gets meetings published on YouTube. It implements
`@open-minutes/core`'s `VideoLister` for a channel or playlist (`youtubeSource`:
the videos in it) and `AudioProvider` for a video (`youtube`: its metadata, and
its audio as 16 kHz mono WAV).
It knows nothing about the database or what happens to the audio next;
`@open-minutes/pipeline` does that.

Metadata and audio come from yt-dlp (`install-ytdlp.sh` installs it, on Linux
or macOS), or, where YouTube blocks yt-dlp (CI, servers), from the project's
object store, which the
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

[`egress/`](egress/) has the scripts the
[`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml)
workflow uses to run both, which work outside Actions too:

| Script                 | Does                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `install.sh <deb dir>` | Unpacks WARP and Tor into `/opt/youtube-egress` (Linux with apt only) |
| `up.sh [warp] [tor]`   | Starts them and prints one proxy URL per line, WARP's first           |
| `rotate.sh warp\|tor`  | Gives one a new exit and prints its URL                               |
| `down.sh`              | Stops what `up.sh` started                                            |

On Linux:

```sh
packages/youtube/egress/install.sh ~/.cache/youtube-egress-debs
export YOUTUBE_PROXY="$(packages/youtube/egress/up.sh | paste -sd,)"
```

Elsewhere, install Tor yourself (`up.sh tor` finds it on `PATH`) or run WARP
in proxy mode and set `YOUTUBE_PROXY` by hand. `up.sh` leaves WARP alone if a
WARP not started by it is running (the desktop app, say), since `rotate.sh
warp` would delete that install's registration; `YOUTUBE_EGRESS_FORCE=1`
overrides. Its Tor gets its own SOCKS port (9050, or the next free even port)
and data directory, so it doesn't disturb a Tor already running. State and
logs go to `$TMPDIR/youtube-egress`; see [`egress/lib.sh`](egress/lib.sh) for
the variables that move them.
