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
  `pnpm test:all`. The `test-slow` workflow runs them weekly on main, on PRs
  that touch the pipeline, and from the Actions tab on any branch. It runs each
  test as its own job and tabulates every meeting's WER and real-time factor on
  the run's page.
- **yt-dlp tests** run yt-dlp against YouTube. They're skipped unless you ask
  with `pnpm test:ytdlp` or `pnpm test:all`. They pass from a home connection,
  or from Linux with WARP and Tor installed, as in CI (see the
  [ytdlp README](../../packages/ytdlp/README.md)).

A test's own skip condition (`it.skipIf`, `it.runIf`, `{ skip }`) overrides
the `skip` of its tags. A slow test that also skips for another reason has to
repeat the tag's condition, as in `it.skipIf(!token || process.env.SLOW !== "1")`.

## Running some of the tests

`pnpm test` passes its arguments to Vitest:

```sh
pnpm test --project @open-minutes/core   # one package
pnpm test --project @open-minutes/core --project @open-minutes/db
pnpm test packages/core/src/rules        # files under a path
pnpm test -t "alignWords"                # tests whose name matches
pnpm test --changed main                 # tests affected by changes since main
```

`pnpm exec vp test` runs in watch mode and reruns only the tests affected by
each edit. The same arguments work there, and with `pnpm test:slow`.

## Hand-edited datums

The golden meetings in [`packages/datasets`](../../packages/datasets/README.md)
are edited by hand and checked by rules that run in the test suite, from the
command line, and after each edit by a Claude Code hook. That package's README
explains how to check and fix them.
