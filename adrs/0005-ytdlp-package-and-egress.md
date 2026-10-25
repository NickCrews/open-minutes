# ADR 0005: A yt-dlp package that owns the binary, egress and retries

Date: 2026-10-24
Status: Proposed

## Context

Everything Open Minutes gets from YouTube comes through yt-dlp. YouTube
bot-checks single-video requests (metadata and audio) from datacenter IPs, so
from GitHub runners those requests have to leave through another exit:
Cloudflare WARP or Tor, retried with a fresh exit when YouTube refuses one
(see [docs/research/youtube-in-ci.md](../docs/research/youtube-in-ci.md)).
Listing a channel or playlist works from any IP.

The pieces involved are spread across the repo:

| Piece                                                  | Where                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Install yt-dlp                                         | `packages/youtube/install-ytdlp.sh`                                      |
| Install, start, rotate and stop WARP and Tor           | `packages/youtube/egress/*.sh`                                           |
| Try WARP, rotate, fall back to Tor                     | `.github/scripts/fetch-youtube-audio.sh` (bash)                          |
| Try each of `YOUTUBE_PROXY` in turn on a blocked exit  | `ytDlpVia` in `packages/youtube/src/index.ts` (TypeScript)               |
| Re-encode for speech (ffmpeg), upload, record failures | `.github/workflows/fetch-youtube-audio.yml` and `encode-speech-audio.sh` |

The retry logic exists twice, in two languages, with different rules: the bash
script rotates exits, the TypeScript one only walks a fixed list of proxies.

The `fetch-youtube-audio` workflow is also the only thing that writes to the
object store. CI, contributors and reprocessing read YouTube audio from the
store, never from YouTube. Writing needs the `object-store-writer`
environment's secrets, which only runs from `main` get. A client that misses
in the store triggers the workflow and polls for its result, which takes 2–6
minutes per video.

The daily ingest of new meetings (U1 in
[docs/research/audio.md](../docs/research/audio.md)) will run unattended,
probably on a datacenter IP. It should be able to get a video's audio into the
store in one process, without dispatching a workflow per video and waiting on
it.

## Decision

### A new package, `@open-minutes/ytdlp`

It owns everything needed to run the yt-dlp CLI from any machine, and nothing
about YouTube's data model, the object store or the database.

```ts
import { ensureYtDlpInstalled, runWithEgress } from "@open-minutes/ytdlp";

await ensureYtDlpInstalled(); // a no-op when yt-dlp is on PATH or in .cache/bin
const { stdout, route } = await runWithEgress(args, { beforeAttempt });
```

- **`ensureYtDlpInstalled()`** puts yt-dlp's standalone binary in the repo's
  gitignored `.cache/bin` when it isn't on `PATH`. No sudo, Linux and macOS.
  The binary includes yt-dlp's JS challenge scripts. It installs nothing else.
- **`runWithEgress(args, { routes, isBlocked, beforeAttempt })`** is what
  callers use. It runs yt-dlp with `args` through each route in turn, adding
  `--proxy` for a route that has one, starting the route's daemon when it is
  first reached and stopping whatever it started before returning. It
  resolves with yt-dlp's output and the route that worked.
- **`run(args)`** runs yt-dlp once, with no proxy logic, with
  `--js-runtimes node:<this node>` so deno is optional. It rejects with
  yt-dlp's stdout and stderr on failure. `runWithEgress` calls it.
- **`egress({ routes })`** is the manager under `runWithEgress`, for a process
  that runs yt-dlp many times (the daily ingest): its `run(args, options)`
  works like `runWithEgress`, but the daemons stay up and a route found
  blocked stays skipped until `close()`.

#### Routes, and how a caller finds out it needs one

A route is `direct`, `warp`, `tor`, or a fixed `socks5://` URL. The default
list comes from `YOUTUBE_EGRESS` (comma-separated) and is `direct,warp,tor`
when unset. Nobody decides in advance whether a machine needs a proxy:
`direct` is tried first, and the next route is tried only when `isBlocked`
says yt-dlp's error is a refused or unreachable exit (YouTube's bot check, a
403 on the watch page, a proxy that won't connect). Any other error, such as a
private or removed video, is thrown at once. `isBlocked` defaults to the
package's classifier of yt-dlp's error text. On a home connection the first
attempt succeeds and no daemon starts.

The order within each proxy route is that of `fetch-youtube-audio.sh` today:
WARP, then a new WARP registration up to twice; Tor, then a new Tor circuit up
to twice. `beforeAttempt` runs before each attempt, to clear a partial
download.

A route that can't run on this machine is skipped, not an error on its own:
WARP or Tor not installed, not Linux, no root for WARP's daemon, no UDP. On
macOS that leaves `direct`. When no route succeeds, `runWithEgress` rejects
with an `EgressError` whose `routes` lists each route with its outcome
(`blocked` with yt-dlp's last error, or `unavailable` with the reason and what
to install), and whose message says the same.

GitHub runners always fail `direct`, so the workflow sets
`YOUTUBE_EGRESS=warp,tor` to skip that attempt.

#### One manager per machine

A lock file under the egress state directory makes a second process wait for
the first before it starts or rotates a daemon. Rotating an exit changes it
for everyone using it, and two managers would contend for WARP's registration
and Tor's port. `direct` takes no lock.

### Installing egress is explicit

WARP and Tor need Linux with apt, and WARP's daemon runs as root and needs
UDP. That holds on GitHub runners, not on macOS or in sandboxed containers
whose only egress is an HTTPS proxy. So `ensureYtDlpInstalled()` never
installs them. `installWarpAndTor(debDir)` (the current `egress/install.sh`)
is a separate step for machines that can, and where it hasn't run, those
routes are `unavailable`.

The bash scripts in `packages/youtube/egress/` move to the new package as they
are, and the TypeScript manager calls them. They carry timing learned on
runners (waiting for WARP's `NetworkInfoChanged`, IPv4 exits through
`socks5://`, the WARP-then-Tor order). Porting them to TypeScript can come
later.

### `@open-minutes/youtube` builds on it

`getMetadata` and `ensureAudioDownloaded` call `runWithEgress` instead of
`execFile` and `ytDlpVia`. `listRecordings` calls `run`, since listing works
from any IP. `YOUTUBE_PROXY` becomes a fixed-URL route in `YOUTUBE_EGRESS`.

### Writing to the store moves into TypeScript

A new `fetchToStore(videoId, { routes, credentials })` in
`@open-minutes/youtube` does what the workflow's steps do: download through
`runWithEgress`, re-encode with ffmpeg, strip the stream URLs from the info
JSON, upload both, and write `error.json` when every route fails. Upload uses
an S3 client against `OBJECT_STORE_ENDPOINT`.

The audio's format at each stage:

| Stage           | Format                                                                                  | Size         | Made by                                                             |
| --------------- | --------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------- |
| From YouTube    | Opus in WebM (format 251), 48 kHz stereo, ~110 kbps                                     | ~50 MB/hour  | yt-dlp, `-f "bestaudio[ext=webm]"`; one stream, so no ffmpeg        |
| In the store    | `youtube/<id>/speech.webm`: Opus in WebM, 16 kHz mono, 24 kbps                          | ~11 MB/hour  | ffmpeg in `fetchToStore`                                            |
| Into the models | 16 kHz mono 16-bit PCM WAV, which `@open-minutes/audio`'s transcriber and diarizer take | ~115 MB/hour | `webmOpusToWav` in `@open-minutes/youtube`, on the reader's machine |

- **YouTube to the store.** ffmpeg averages the two channels into one
  (`pan=mono|c0=0.5*c0+0.5*c1`, since ffmpeg's own downmix makes dual-mono 3
  dB louder and can clip), resamples to 16 kHz, encodes with libopus at
  24 kbps, and drops metadata (`-map_metadata -1 -fflags +bitexact`). This is
  `encode-speech-audio.sh` today. The models take 16 kHz mono, so nothing they
  use is lost. YouTube's original isn't kept. Beside it goes
  `youtube/<id>/info.json`, yt-dlp's metadata minus its expiring stream URLs.
- **The store to the models.** `webmOpusToWav` demuxes the WebM and decodes
  with libopus compiled to WebAssembly, asking it for 16 kHz mono directly, so
  readers need no ffmpeg and get the same bytes on every machine. A reader
  that downloads from YouTube itself decodes the original the same way; the
  result has the same length as the stored copy's, at zero lag, with
  correlation ~0.997.

ffmpeg is needed only for the first step, so it lives in `fetchToStore`, not
in `@open-minutes/ytdlp`. `fetchToStore` installs a static ffmpeg build into
`.cache/bin` when it isn't on `PATH`, so this step needs no apt either.

Callers:

- **The daily ingest** runs where it has the writer credentials and calls
  `fetchToStore` itself.
- **The `fetch-youtube-audio` workflow** becomes `pnpm om fetch-audio <id>`
  after installing WARP and Tor, so the workflow and the ingest share one
  implementation.
- **Everything else** (fork CI, contributors, sandboxed containers) keeps
  reading the store and, with `YOUTUBE_AUDIO_DISPATCH_TOKEN`, triggering the
  workflow on a miss.

The workflow stays because it is the only writer those callers can reach:
they have neither the store's write credentials nor, often, a route to
YouTube. It handles videos the daily ingest didn't fetch, such as a fixture
or a backfill of older meetings. If every video the project uses comes
through the ingest, the dispatch path and the workflow can go.

### Not decided here

- **Where the daily ingest runs.** This design assumes a scheduled GitHub
  Actions job on `main` with the `object-store-writer` environment, which can
  run WARP and Tor. A home machine works too, with `direct` as its route.
- **Whether a scout lists and reads metadata through the YouTube Data API.**
  A scout will own audio ingestion, so it runs yt-dlp for the audio either
  way. Listing and metadata (the title and description that say whether a
  video is a meeting) could instead come from the YouTube Data API v3, with an
  API key, no bot check and a free quota far above our use. That belongs with
  the scout's design.

## Consequences

- One retry policy, in TypeScript, tested with a fake yt-dlp and fake egress.
  The real egress is exercised only on runners, through the
  `fetch-youtube-audio` workflow.
- The ingest gets audio in about the time the download takes (11 s for a
  92-minute meeting through WARP), instead of 2–6 minutes per video waiting on
  a workflow.
- More code runs with the store's write credentials: whatever runs the ingest
  holds them, not only a workflow pinned to `main`.
- `@open-minutes/youtube` no longer shells out directly, so its tests mock one
  module instead of `node:child_process`.
- Downloading from YouTube is supported only from a residential connection
  or from Linux with root and UDP, where WARP and Tor run (GitHub runners).
  Elsewhere, such as a sandboxed container whose only egress is an HTTPS
  proxy or a laptop on a VPN, `runWithEgress` rejects with
  `EgressError` and the caller reads the store, which the workflow fills.

## Alternatives considered

- **Keep the workflow as the only writer** and have the ingest dispatch it per
  video. Keeps write credentials in one place, but every new meeting costs a
  runner start and a polling loop, and failures are split across two logs.
- **Install everything, WARP and Tor included, from `ensureYtDlpInstalled()`.** Would
  make the API one call, but it would run sudo and register WARP as a side
  effect of a library call, and fail on every machine without apt.
- **Make callers pick routes.** A caller would check its platform and
  connection and pass the routes it needs. Trying `direct` first answers the
  same question with one request, on the machine where it matters.
- **Port the egress scripts to TypeScript now.** Cleaner, but rewrites
  runner-tested timing that can only be re-tested on runners. Wrapping them
  first keeps that change separate.
- **Put egress in its own package.** Nothing but yt-dlp uses it today; a module
  inside `@open-minutes/ytdlp` can be split out when something else does.
