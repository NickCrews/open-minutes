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
import { ensureInstalled, egress, run } from "@open-minutes/ytdlp";

await ensureInstalled(); // yt-dlp only; a no-op when it's there
const exits = await egress({ routes: ["warp", "tor"] });
try {
  const { stdout } = await exits.run(
    (proxy) => run([...args, ...(proxy ? ["--proxy", proxy] : [])]),
    { isBlocked, beforeAttempt },
  );
} finally {
  await exits.close();
}
```

- **`ensureInstalled()`** puts yt-dlp's standalone binary in the repo's
  gitignored `.cache/bin` when it isn't on `PATH`. No sudo, Linux and macOS.
  The binary includes yt-dlp's JS challenge scripts.
- **`run(args)`** runs yt-dlp with `--js-runtimes node:<this node>`, so deno
  is optional, and rejects with yt-dlp's stdout and stderr on failure.
- **`egress({ routes })`** returns an egress manager for an ordered list of
  routes: `direct`, `warp`, `tor`, or a fixed `socks5://` URL. It starts the
  WARP and Tor daemons a route needs, and `close()` stops whatever it started.
- **`exits.run(attempt, { isBlocked, beforeAttempt })`** calls `attempt` with
  each route's proxy URL (`undefined` for `direct`), in the order of
  `fetch-youtube-audio.sh` today: WARP, a new WARP registration up to twice,
  then Tor, a new Tor circuit up to twice. It moves on only when `isBlocked`
  says the error is a refused or unreachable exit; any other error is thrown
  at once. `beforeAttempt` clears a partial download. When every route fails,
  the error names each route and its last error.
- **One manager per machine.** A lock file under the egress state directory
  makes a second process wait for the first. Rotating an exit changes it for
  everyone using it, and two managers would contend for WARP's registration
  and Tor's port.

The default routes come from `YOUTUBE_EGRESS` (comma-separated). Unset, the
only route is `direct`: a developer on a home connection needs no proxy, and
starting WARP takes root.

### Installing egress is explicit

WARP and Tor need Linux with apt, and WARP's daemon runs as root and needs
UDP. That holds on GitHub runners, not on macOS or in sandboxed containers
whose only egress is an HTTPS proxy. So `ensureInstalled()` never installs
them. `installEgress(debDir)` (the current `egress/install.sh`) is a separate
step for machines that can, and `egress()` fails at once, saying what to
install, when a route's daemon isn't there.

The bash scripts in `packages/youtube/egress/` move to the new package as they
are, and the TypeScript manager calls them. They carry timing learned on
runners (waiting for WARP's `NetworkInfoChanged`, IPv4 exits through
`socks5://`, the WARP-then-Tor order). Porting them to TypeScript can come
later.

### `@open-minutes/youtube` builds on it

`getMetadata`, `ensureAudioDownloaded` and `listRecordings` call `run` through
an egress manager instead of `execFile` and `ytDlpVia`. Listing always goes
`direct`. `YOUTUBE_PROXY` becomes a fixed-URL route in `YOUTUBE_EGRESS`.

### Writing to the store moves into TypeScript

A new `fetchToStore(videoId, { routes, credentials })` in
`@open-minutes/youtube` does what the workflow's steps do: download through
the egress manager, re-encode to 16 kHz mono Opus at 24 kbps with ffmpeg,
strip the stream URLs from the info JSON, upload both, and write `error.json`
when every route fails. Upload uses an S3 client against
`OBJECT_STORE_ENDPOINT`.

ffmpeg is needed only here, so it lives here, not in `@open-minutes/ytdlp`:
yt-dlp downloads a single format without it, and the pipeline decodes Opus
with WebAssembly. `fetchToStore` installs a static ffmpeg build into
`.cache/bin` when it isn't on `PATH`, so this step needs no apt either.

Callers:

- **The daily ingest** runs where it has the writer credentials and calls
  `fetchToStore` itself.
- **The `fetch-youtube-audio` workflow** becomes `pnpm om fetch-audio <id>`
  after installing egress, so the workflow and the ingest share one
  implementation.
- **Everything else** (fork CI, contributors, sandboxed containers) keeps
  reading the store and, with `YOUTUBE_AUDIO_DISPATCH_TOKEN`, triggering the
  workflow on a miss.

### Not decided here

- **Where the daily ingest runs.** This design assumes a scheduled GitHub
  Actions job on `main` with the `object-store-writer` environment, which can
  run WARP and Tor. A home machine works too, with `direct` as its route.
- **How a scout reads video metadata.** Deciding whether a video is a meeting
  needs its title and description. The YouTube Data API v3 gives listing and
  metadata with an API key, no bot check and a free quota far above our use,
  so a scout may need no yt-dlp at all. That belongs with the scout's design.

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
- A machine that can't run WARP or Tor and isn't on a residential connection
  still can't download from YouTube. It reads the store or triggers the
  workflow, as now.

## Alternatives considered

- **Keep the workflow as the only writer** and have the ingest dispatch it per
  video. Keeps write credentials in one place, but every new meeting costs a
  runner start and a polling loop, and failures are split across two logs.
- **Install everything, egress included, from `ensureInstalled()`.** Would
  make the API one call, but it would run sudo and register WARP as a side
  effect of a library call, and fail on every machine without apt.
- **Port the egress scripts to TypeScript now.** Cleaner, but rewrites
  runner-tested timing that can only be re-tested on runners. Wrapping them
  first keeps that change separate.
- **Put egress in its own package.** Nothing but yt-dlp uses it today; a module
  inside `@open-minutes/ytdlp` can be split out when something else does.
