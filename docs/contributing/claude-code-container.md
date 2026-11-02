# Claude Code in a cloud container

This covers what differs from [Getting started](../../CONTRIBUTING.md#getting-started)
when you are Claude Code running in a claude.ai cloud container. If something
here is out of date, please open a PR to fix it.

## Node and pnpm

`node` on `PATH` is Node 22 (`/opt/node22`), but `devEngines` in
`package.json` pins Node `^24.11.0` and pnpm `10.33.0`. Node 24 is installed
at `/opt/node24`, and its corepack fetches the pinned pnpm:

```sh
export PATH=/opt/node24/bin:$PATH
corepack pnpm@10.33.0 install
```

After install, `vp` is in `node_modules/.bin`: run it as `pnpm exec vp ...`,
or use the root scripts (`pnpm test`, `pnpm lint`, `pnpm check`, ...).

`pnpm install` warns `Ignored build scripts: workerd`. The dev server runs
without approving it.

## Postgres

The Docker client is installed but the daemon is not running, so every test
that needs Postgres fails until you start it:

```sh
nohup sudo dockerd > /tmp/dockerd.log 2>&1 &
until docker info >/dev/null 2>&1; do sleep 1; done
```

After that, the repo's tooling runs `docker compose up` itself when nothing
is listening on 5432, so `pnpm test` and `pnpm dev` work unchanged. The first
pull of `pgvector/pgvector:pg18` takes about 20 seconds.

The daemon does not survive an interrupted or restarted session; check
`docker info` and start it again if needed.

The image also has a Postgres 16 server installed (stopped, port 5432, no
pgvector). Don't use it: the schema needs pgvector and prod runs Postgres 18.

## YouTube and yt-dlp

yt-dlp tests are skipped unless `YTDLP=1`. `pnpm test:ytdlp` installs yt-dlp
into `.cache/bin` if it isn't on `PATH`; `packages/ytdlp/install-ytdlp.sh`
installs it system-wide.

From the container, YouTube metadata works (with the `mweb` and
`web_embedded` clients) but every audio download fails with HTTP 403 from
`googlevideo.com`. The `warp` and `tor` egress routes can't help: the
container's only egress is an HTTPS proxy, which carries neither WARP's UDP
nor Tor's TCP ports (see the [ytdlp README](../../packages/ytdlp/README.md#routes)).
Audio has to come from the blob store or the `fetch-youtube-audio` workflow
(see [Meeting audio](audio.md)).

## Long-running processes

Background processes, such as `pnpm dev`, are stopped after 30 minutes.
Restart them if needed, or point the user at the PR's preview deployment.

## Tests

`AI_AGENT` is set, which changes Vitest's output; see
[Testing](testing.md#running-some-of-the-tests).

## GitHub

- The GitHub integration cannot re-run CI jobs (HTTP 403). A job that failed
  for reasons outside the PR, such as Neon's "branches limit exceeded" on
  preview deploys, needs a maintainer to re-run it.
