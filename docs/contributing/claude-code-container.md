# Claude Code in a cloud container

Last updated: 2026-11-02. If something here is out of date, please open a PR
to fix it.

This covers what differs from [Getting started](../../CONTRIBUTING.md#getting-started)
when you are Claude Code running in a claude.ai cloud container.

## Node and pnpm

The container ships Node 22 (`/opt/node22`) and pnpm 10.28, while
`devEngines` in `package.json` pins Node `^24.11.0` and pnpm `10.33.0`.
`pnpm install` still completes with the container's versions, so install
dependencies with plain `pnpm install`.

`vp` is not on `PATH`. Run it through the workspace: `pnpm exec vp ...`, or
use the root scripts (`pnpm test`, `pnpm lint`, `pnpm check`, ...).

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
`googlevideo.com`. Audio has to come from the blob store or the
`fetch-youtube-audio` workflow (see [Meeting audio](audio.md)).

If deno is on `PATH`, yt-dlp runs it and it may leave a `deno.lock` in the
working tree. Don't commit it.

## Long-running processes

Background processes, such as `pnpm dev`, are stopped after 30 minutes.
Restart them if needed, or point the user at the PR's preview deployment.

## Tests

- `AI_AGENT` is set in the container, so Vitest hides the console output of
  passing tests. Add `--reporter=default` to see it (for example the `WER=`
  lines of the transcription evals).
- `packages/core/src/transcription/wer.perf.test.ts` is timing-based and can
  fail when the whole suite runs in parallel. Rerun it alone before treating
  a failure as real.

## Repository gotchas

- `.gitignore` ignores every directory named `models/`, anywhere in the tree.
  A new directory with that name won't show up in `git status`.

## GitHub

- The GitHub integration cannot re-run CI jobs (HTTP 403). A job that failed
  for reasons outside the PR, such as Neon's "branches limit exceeded" on
  preview deploys, needs a maintainer to re-run it.
