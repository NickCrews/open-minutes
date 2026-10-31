# Testing

`pnpm check` runs everything a commit needs: typechecking, formatting, lint
and the fast tests. The root `package.json` lists the other test commands.

## Kinds of tests

- **Fast tests** run by default and are what `pnpm test` runs. Tests that need
  a database each get a fresh copy of a pre-seeded template, which takes
  milliseconds; see [db.md](db.md#databases-in-tests).
- **Slow tests** take more than 10 seconds. Most transcribe or diarize whole
  golden meetings and score the result, which takes 10–20 minutes each on CPU.
  They're skipped unless you ask for them with `pnpm test:slow` or
  `pnpm test:all`.
- **yt-dlp tests** run yt-dlp against YouTube. They're skipped unless you ask
  with `pnpm test:ytdlp` or `pnpm test:all`. They pass from a home connection,
  or from Linux with WARP and Tor installed, as in CI (see the
  [ytdlp README](../../packages/ytdlp/README.md)).

## Hand-edited datums

The golden meetings in [`packages/datasets`](../../packages/datasets/README.md)
are edited by hand and checked by rules that run in the test suite, from the
command line, and after each edit by a Claude Code hook. That package's README
explains how to check and fix them.
