# @open-minutes/scouts

The scouts, which find recordings on the sites that publish meetings, and the
harness that runs them, writes what they report to `recordings` and
`recording_bodies`, and stores each recording's audio in the blob store. How
it all works: [recordings.md](../../docs/contributing/recordings.md).

```sh
pnpm scout run --scout akleg --dry-run   # what it would write and fetch
pnpm scout run --scout akleg --audio-cap 0   # scout only, into your local database
pnpm scout run                           # every scout that is due, then audio
pnpm scout available                     # recordings ready to become meetings
pnpm scout failed                        # recordings whose audio was given up on
```

Every command takes `--db`, like `pnpm db`'s. Fetching audio needs ffmpeg,
yt-dlp's egress for YouTube (see [`packages/ytdlp`](../ytdlp/README.md)), and
the AWS CLI with the blob store's write settings from
[`.env.example`](../../.env.example). The
[`scout`](../../.github/workflows/scout.yml) workflow runs `pnpm scout run`
hourly against production.

- `src/scouts/`: the scouts, and `SCOUTS`, the list of them.
- `src/harness.ts`: scanning, writing reports, and the audio step.
- `src/run.ts`: what `pnpm scout run` does.
- `src/audio-tools.ts`: encoding, probing and uploading audio.

## Tests

- `harness.test.ts` runs the harness with fake scouts and fake audio tools on
  a test database.
- `scouts/live.test.ts` runs each scout against its live site. The akleg.gov
  one runs with every `pnpm test`; the YouTube ones are tagged `ytdlp`.
- `fetch-audio.live.test.ts` runs each site's `FetchAudio` on one short
  recording, and encodes the result when ffmpeg is installed.
