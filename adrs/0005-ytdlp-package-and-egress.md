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

| Piece                                                 | Where                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| Install yt-dlp                                        | `packages/youtube/install-ytdlp.sh`                        |
| Install, start, rotate and stop WARP and Tor          | `packages/youtube/egress/*.sh`                             |
| Try WARP, rotate, fall back to Tor                    | `.github/scripts/fetch-youtube-audio.sh` (bash)            |
| Try each of `YOUTUBE_PROXY` in turn on a blocked exit | `ytDlpVia` in `packages/youtube/src/index.ts` (TypeScript) |

The retry logic exists twice, in two languages, with different rules: the bash
script rotates exits, the TypeScript one only walks a fixed list of proxies.

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
  that runs yt-dlp many times, like a scout: its `run(args, options)`
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

### The workflow downloads through it

The `fetch-youtube-audio` workflow's download step calls `runWithEgress`
through a small TypeScript script in place of `fetch-youtube-audio.sh`, after
`installWarpAndTor`. Its other steps (re-encoding, upload, `error.json`) are
unchanged.

### Not decided here

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
- `@open-minutes/youtube` no longer shells out directly, so its tests mock one
  module instead of `node:child_process`.
- Downloading from YouTube is supported only from a residential connection
  or from Linux with root and UDP, where WARP and Tor run (GitHub runners).
  Elsewhere, such as a sandboxed container whose only egress is an HTTPS
  proxy or a laptop on a VPN, `runWithEgress` rejects with
  `EgressError` and the caller reads the store, which the workflow fills.

## Alternatives considered

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
