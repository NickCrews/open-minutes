# @open-minutes/ytdlp

Runs the [yt-dlp](https://github.com/yt-dlp/yt-dlp) CLI from any machine. It
installs yt-dlp, and gets it past YouTube's bot check on datacenter IPs by
routing it through Cloudflare WARP or Tor. `@open-minutes/youtube` builds on
it. See [ADR 0005](../../adrs/0005-ytdlp-package-and-egress.md) for why.

```ts
import { ensureYtDlpInstalled, runWithEgress } from "@open-minutes/ytdlp";

await ensureYtDlpInstalled();
const { stdout, route } = await runWithEgress(["--skip-download", "-J", url]);
```

| Export                         | Does                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `ensureYtDlpInstalled()`       | Puts yt-dlp's standalone binary in the repo's `.cache/bin`, unless it's on `PATH` or already there. No sudo. |
| `runWithEgress(args, options)` | Runs yt-dlp through each route in turn until one gets through; see below.                                    |
| `run(args)`                    | Runs yt-dlp once, with no proxy logic. Rejects with a `YtDlpError`.                                          |
| `egress(options)`              | The manager under `runWithEgress`, for a process that runs yt-dlp many times.                                |
| `installWarpAndTor(debDir)`    | Unpacks WARP and Tor so the `warp` and `tor` routes can run. Linux with apt, and sudo.                       |

## The `ytdlp` CLI

The same API for shell scripts and workflows, such as
[`fetch-youtube-audio`](../../.github/workflows/fetch-youtube-audio.yml):

```sh
pnpm exec ytdlp install                    # ensureYtDlpInstalled()
pnpm exec ytdlp install-egress <deb dir>   # installWarpAndTor(debDir)
pnpm exec ytdlp run [--routes warp,tor] [--logs <dir>] -- <yt-dlp args>
```

`run` installs yt-dlp if needed, then calls `runWithEgress` with the
arguments after `--`. yt-dlp's stdout goes to stdout; the route that worked
and any error go to stderr, and it exits 1 when no route gets through.
`--routes` overrides `YOUTUBE_EGRESS`. `--logs <dir>` copies WARP's and Tor's
logs into `dir` when done, plus `last-error.txt` with the error on failure.
A retry through a new exit doesn't clear a partial download; pass yt-dlp
`--no-continue --force-overwrites` to start each attempt over.

yt-dlp solves YouTube's JS challenges with the node running it, or with
[deno](https://deno.com) if that's on `PATH`.

## Routes

A route is `direct`, `warp`, `tor`, or a proxy URL such as
`socks5://127.0.0.1:9050`. They're tried in the order of `YOUTUBE_EGRESS`
(comma-separated), or `direct,warp,tor` when it's unset. The next route is
tried only when yt-dlp's error says the exit was refused or unreachable
(`isBlockedExit`: the bot check, a 403 or 429, a proxy that won't connect);
any other error, such as a private video, is thrown at once. So on a home
connection, `direct` works and nothing starts.

`warp` and `tor` are started when first reached. Each gets up to three
attempts: its first exit, then up to two new ones (a new WARP registration,
which often keeps the same exit IP, or a new Tor circuit). Proxied attempts
pass `--retries 2 --fragment-retries 2`, since a new exit is the better retry.
`runWithEgress` stops what it started before returning; an `egress()`
manager keeps them up, and skips a route found blocked, until `close()`.

A route that can't run here is skipped: WARP needs Linux, root (or
passwordless sudo) and UDP; Tor needs to be unpacked by `installWarpAndTor`
or on `PATH`. When no route works, `runWithEgress` rejects with an
`EgressError` whose `routes` say what happened on each, `blocked` (with
yt-dlp's last error) or `unavailable` (with the reason and what to install).
Downloading from YouTube works from a residential connection, or from Linux
with root and UDP, such as GitHub's runners. A sandboxed container whose only
egress is an HTTPS proxy can run neither WARP (UDP) nor Tor (arbitrary TCP
ports).

Use `socks5://`, not `socks5h://`, for a proxy URL: IPv4 exits got through
more often (see
[docs/research/youtube-in-ci.md](../../docs/research/youtube-in-ci.md)).

### One manager per machine

Before starting a daemon, a manager takes a lock file in the egress state
directory and holds it until it closes; another process that needs a daemon
waits for it. Rotating an exit changes it for everyone using it, and two
managers would contend for WARP's registration and Tor's port. `direct` and
proxy URLs need no lock.

## The egress scripts

[`egress/`](egress/) has the bash scripts the manager runs. They carry timing
learned on runners, and work on their own too:

| Script                 | Does                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `install.sh <deb dir>` | Unpacks WARP and Tor into `/opt/youtube-egress` (Linux with apt only) |
| `up.sh [warp] [tor]`   | Starts them and prints one proxy URL per line, WARP's first           |
| `rotate.sh warp\|tor`  | Gives one a new exit and prints its URL                               |
| `down.sh`              | Stops what `up.sh` started                                            |

`up.sh` leaves WARP alone if a WARP not started by it is running (the desktop
app, say), since `rotate.sh warp` would delete that install's registration;
`YOUTUBE_EGRESS_FORCE=1` overrides. Its Tor gets its own SOCKS port (9050, or
the next free even port) and data directory, so it doesn't disturb a Tor
already running. State, logs and the manager's lock go to
`$TMPDIR/youtube-egress`; see [`egress/lib.sh`](egress/lib.sh) for the
variables that move them.
