# Contributing to Open Minutes

This is the technical guide: how Open Minutes works, how to run it, and how to
work with its data directly. For what the project is and who it's for, see the
[README](README.md).

## Vocabulary

Terms like _body_, _meeting_, _segment_, _speaker_, and _person_ have specific
meanings here. See [`TERMINOLOGY.md`](TERMINOLOGY.md) and use those terms in
code, comments, and commit messages.

## How it works

```
YouTube ──yt-dlp──▶ pipeline (om ingest) ──▶ Postgres + pgvector ◀── web (Cloudflare Workers)
                    transcribe / diarize /       (local Docker or Neon)
                    align / recognize
```

A [pnpm](https://pnpm.io) workspace of these packages. Each depends only on
the ones listed above it:

- **[`packages/core`](packages/core)** (`@open-minutes/core`): shared domain
  code with no database or I/O: transcript and timeline types, transcript
  cleaning and speaker alignment, word error rate, chapter rules, reading a
  meeting's date from its title and transcript, the interface a video site
  implements, voice-embedding constants, and `.env.local` loading.
- **[`packages/db`](packages/db)** (`@open-minutes/db`): the
  [Drizzle](https://orm.drizzle.team) schema and migrations, the `pnpm db` CLI,
  and the per-test database helpers (`@open-minutes/db/testing/vitest`).
- **[`packages/glossary`](packages/glossary)** (`@open-minutes/glossary`): the
  local words of each region (Anchorage, Girdwood), what they mean and how
  speech recognition mishears them. Kept as static data for now.
- **[`packages/fixtures`](packages/fixtures)** (`@open-minutes/fixtures`): the
  data that seeds local and test databases. `test-data/` holds the real,
  hand-verified jurisdictions, bodies, people and golden meetings, and
  `@open-minutes/fixtures/audio` gets a golden meeting's audio, checked against
  the audio its transcript was timed to. Nothing here ships to production.
- **[`packages/datasets`](packages/datasets)** (`@open-minutes/datasets`): the
  datasets that seed local and test databases, each a JSON spec in `specs/`
  naming which test-data rows to seed, and the seeder that loads them (see
  [db.md](docs/contributing/db.md)).
- **[`packages/audio`](packages/audio)** (`@open-minutes/audio`): speech
  processing, run locally with
  [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). It transcribes a
  meeting's audio (NeMo Parakeet ASR + Silero VAD) and diarizes it into speaker turns (pyannote
  segmentation + CAM++ voice embeddings). No GPU or external API is needed;
  models are downloaded on first use (or all at once with `pnpm om models`).
  See the [audio README](packages/audio/README.md).
- **[`packages/youtube`](packages/youtube)** (`@open-minutes/youtube`): the
  YouTube source. It lists a channel's or playlist's videos and gets a video's
  metadata and Opus audio with yt-dlp. See the
  [youtube README](packages/youtube/README.md).
- **[`packages/codecs`](packages/codecs)** (`@open-minutes/codecs`): decodes
  the WebM/Opus and MP3 audio sites serve to the 16 kHz mono WAV the models
  want, in WebAssembly with no ffmpeg. See the
  [codecs README](packages/codecs/README.md).
- **[`packages/blobstore`](packages/blobstore)** (`@open-minutes/blobstore`): the
  blob store (see below): reads a file from the bucket by key, from Node or
  the browser. See the
  [blobstore README](packages/blobstore/README.md).
- **[`packages/akleg`](packages/akleg)** (`@open-minutes/akleg`): the source
  for the Alaska Legislature's meetings on akleg.gov, a peer of the YouTube
  source. It lists a committee's recorded meetings and gets a meeting's
  metadata and MP3 audio. See the
  [akleg README](packages/akleg/README.md).
- **[`packages/meeting-audio`](packages/meeting-audio)**
  (`@open-minutes/meeting-audio`): YouTube's audio by way of the blob store,
  and a per-machine cache of meetings' decoded audio. See the
  [meeting-audio README](packages/meeting-audio/README.md).
- **[`packages/ingest`](packages/ingest)** (`@open-minutes/ingest`): the
  offline ingestion pipeline. It gets a meeting's audio from
  `@open-minutes/meeting-audio` (YouTube, by way of the blob store) or
  `@open-minutes/akleg`, runs it through `@open-minutes/audio`, aligns turns to words, recognizes speakers
  against known voiceprints, and writes the meeting to the database. See the
  [ingest README](packages/ingest/README.md).
- **[`packages/cli`](packages/cli)** (`@open-minutes/cli`): the `om` CLI, for
  development: `om ingest` and friends over `@open-minutes/ingest`, and
  `om models`. It only parses arguments and wires stdio; the logic lives in
  the packages it calls.
- **[`packages/web`](packages/web)** (`@open-minutes/web`): the public
  transcript browser, built with [SolidJS](https://www.solidjs.com) +
  [TanStack Start](https://tanstack.com/start), Kobalte and Tailwind, deployed
  to [Cloudflare Workers](https://workers.cloudflare.com).

**Database:** PostgreSQL with [pgvector](https://github.com/pgvector/pgvector)
(voiceprints are stored as vectors with an HNSW index). Locally it runs in
Docker via [`docker-compose.yml`](docker-compose.yml). Production is on
[Neon](https://neon.tech), which the Worker reaches over Neon's HTTP driver
(Workers can't open raw TCP sockets).

**Data model:** **jurisdictions** contain **bodies**, each with at most one
**meeting source** (a YouTube channel or playlist, or an akleg.gov
committee) that is scanned for new meetings. **Meetings** are held by one or
more bodies (`meeting_bodies`), all equal: a **joint meeting**, held by several,
counts as a meeting of each. Ingestion records the one body whose source
published a meeting.
Meetings record their timezone, the site they were published on (YouTube or
akleg.gov), and each meeting's
transcript is a sequence of **segments** (a run of words by one speaker, with
word-level onsets). Segments are attributed to **people**, who carry a
voiceprint so they can be recognized in later meetings. A meeting may also have
**chapters**, a table of contents of titled time ranges (see
[docs/chapters.md](docs/chapters.md)). See
[`packages/db/src/schema.ts`](packages/db/src/schema.ts). The configured
bodies and their meeting sources live in
[`packages/fixtures/test-data/`](packages/fixtures/test-data/); adding a body
means adding rows there.

Design decisions are recorded in [`adrs/`](adrs/).

## Getting started

You need:

- **Node 22** and **pnpm 10.33.0** (pinned in `package.json`;
  `corepack enable` picks it up).
- **Docker** with Compose, for the local Postgres.
- Nothing for yt-dlp, which fetches videos not yet in the blob store
  (below): it's installed into `.cache/bin` the first time it's needed, if
  it isn't on your `PATH`. It runs YouTube's player JS with node, or with
  [deno](https://deno.com) if that's on your `PATH`, which sandboxes it more
  tightly.

Then:

```sh
pnpm install
pnpm dev       # http://localhost:3000
```

`pnpm dev` starts Postgres in Docker, creates, migrates and seeds a database for
your git branch, and starts the web dev server. Editing affordances (e.g. renaming a person) are
enabled only in dev. `pnpm web:dev` starts only the dev server: it creates and
migrates the database too, but doesn't seed it.

No configuration is needed for local development. Optional settings go in a
gitignored `.env.local` at the repository root; see
[`.env.example`](.env.example).

## The database

Each git branch gets its own local database, which `pnpm dev` manages. The
commands you'll reach for most:

```sh
pnpm db status                      # what state is my database in?
pnpm db up --schema-reset always    # start over with fresh sample data
pnpm db generate                    # write a migration after editing schema.ts
```

See [docs/contributing/db.md](docs/contributing/db.md) for everything else.

To query production's data without credentials, use the nightly DuckDB
export: see [skills/open-minutes-data/SKILL.md](skills/open-minutes-data/SKILL.md).

## Deploying

Production is the `production` branch, and GitHub Actions deploys every push to
it. To deploy, the repo owner comments `/deploy` on a merged PR (or runs the
`production` workflow from the Actions tab). That fast-forwards `production` to
the PR's merge commit, builds, migrates the production database just before
switching traffic, and replies with the result.

We don't roll back; we only roll forward. `production` only moves forward along
`main`, so to undo a bad deploy, fix it or revert the PR on `main` and deploy
that. Migrations needn't be backward-compatible: old code briefly runs on the
new schema, and the site may break for those few seconds.

See [docs/contributing/deploy.md](docs/contributing/deploy.md) for the details
and one-time setup.

## Running checks

```sh
pnpm check       # typecheck + format:check + lint + test (run this before committing)
pnpm test        # fast tests only
pnpm test:slow   # only the tests tagged `slow`
pnpm test:ytdlp  # only the tests tagged `ytdlp`
pnpm test:all    # everything, including slow and ytdlp tests
pnpm bench       # time the audio models per minute of audio (*.bench.ts)
pnpm format      # prettier --write over the repo
```

Tests that need a database clone a cached, pre-seeded template. Tests
tagged `slow` run full-meeting transcription and diarization and take roughly
10–20 minutes each on CPU. They're skipped unless `SLOW=1`, which `test:slow`
and `test:all` set for you. Tests tagged `ytdlp` run yt-dlp against YouTube;
they're skipped unless `YTDLP=1`, which `test:ytdlp` and `test:all` set, and
then yt-dlp is installed into `.cache/bin` if it isn't on your `PATH`. They
pass from a home connection, or from Linux with WARP and Tor installed (see
the [ytdlp README](packages/ytdlp/README.md)), as in the
[`ytdlp`](.github/workflows/ytdlp.yml) workflow.

Shared test configuration is in `vitest.config.ts`, `vitest.shared.ts` and
`test-setup.ts` at the repository root.

### Checking hand-edited test data

Golden fixture files follow the rules in
[`packages/core/src/rules/`](packages/core/src/rules/), one file each.
`pnpm fixtures:check [file ...]` prints `file:line: severity: message`, and
also checks the file format. Errors fail it and the test suite.

Some rules have a fix, which rewrites the meeting to remove what the rule
finds where the data alone says what the right rewrite is, such as dropping
a filler word or writing a plain hyphen for an en or em dash.
`pnpm fixtures:fix [file ...]` applies every
fix to the golden fixtures, rewriting their meeting.json, transcript and
chapters.json in place (`--help` lists the fixes, `--verbose` each violation fixed).

[`.claude/settings.json`](.claude/settings.json) runs the same check as a
Claude Code hook after every edit to those files, so an agent sees the
problem on the turn it makes it.

### Transcript cleaning

Right after transcription, `om ingest` runs a **clean** stage that applies
the fixes of the rules in `CLEANING_RULE_SPECS`
([`packages/core/src/rules/clean.ts`](packages/core/src/rules/clean.ts)) to
the recognizer's verbatim output, such as dropping filler words ("um", "uh")
and stuttered function words ("the the");
the cached `transcription.json` stays verbatim, so a rule change applies on
the next run without re-transcribing.

Golden transcripts must already be clean, or the pipeline's output would be
scored against disfluencies it removed on purpose. `pnpm fixtures:check`
reports any left in a golden as an error, so the tests and the hook above
catch them in new goldens too. `pnpm fixtures:fix` removes them, with the
same fixes.

To add a cleanup, write a rule with a fix in `packages/core/src/rules/`, add
it to `RULE_SPECS` and `CLEANING_RULE_SPECS` with tests, then run
`pnpm fixtures:fix` and review the golden diff.

## Running the pipeline

```sh
pnpm om status          # meetings already ingested
pnpm om available       # meetings not yet ingested, on bodies' meeting sources
pnpm om ingest <id>     # run the full pipeline for a meeting
pnpm om models          # download every ML model up front (~650MB)
```

From a server or CI runner, YouTube answers yt-dlp with "sign in to confirm
you're not a bot". Metadata and audio come from the blob store instead: the
project's S3-compatible bucket (Cloudflare R2), public at
`BLOB_STORE_PUBLIC_URL`, where the
[`fetch-youtube-audio`](.github/workflows/fetch-youtube-audio.yml) workflow
stores each video's yt-dlp metadata and audio under `youtube/<video id>/`
after downloading them through Cloudflare WARP or Tor. The audio is re-encoded
to 16 kHz mono Opus at 24 kbps (~11 MB per hour) to keep storage small. The pipeline decodes
the Opus to 16 kHz mono wav itself, with libopus compiled to WebAssembly, so
reading from the store needs neither yt-dlp nor ffmpeg. With
`YOUTUBE_AUDIO_DISPATCH_TOKEN` set, a missing video triggers that workflow and
waits for it; without it, a missing video is downloaded with yt-dlp, which
works from a home connection. See [`.env.example`](.env.example) and
[docs/research/youtube-in-ci.md](docs/research/youtube-in-ci.md).

`om` (in [`packages/cli`](packages/cli/src/om.ts)) writes to the
same database as everything else (`DB=prod pnpm om ingest <id>` to ingest
into production). See [`packages/ingest/README.md`](packages/ingest/README.md)
for details.

## Working with the data directly

It's plain Postgres. Transcripts live in `segments` (with generated `text`,
`start_secs` and `end_secs` columns derived from the word-level `words` JSON),
joined to `meetings`, `bodies` and `people`. For example:

```sql
SELECT m.title, p.name, s.start_secs, s.text
FROM segments s
JOIN meetings m ON m.id = s.meeting_id
LEFT JOIN people p ON p.id = s.person_id
WHERE s.text ILIKE '%snow removal%'
ORDER BY m.start_time, s.start_secs;
```

`pnpm db studio` opens a browser UI on it. The pipeline's API (`listIngested`,
`listAvailable`, `ingestVideo` from `@open-minutes/ingest/om`) and `om`'s
JSON output (`pnpm -s om status --json`) are designed to be composed.

## Architecture Decision Records

Significant design decisions are recorded in [`adrs/`](adrs/) as numbered
Markdown files: `NNNN-short-kebab-title.md`. Follow the format of the existing
ADRs:

- A `# ADR NNNN: Title` heading, followed by `Date:` and `Status:`
  (`Proposed` or `Accepted`) lines.
- `## Context`, then `## Decision`, plus any supporting sections (for example
  a comparison of the alternatives considered).

Commit the ADR alongside the change it describes, or on its own if it only
records research, and mention it in the commit message.

## Commits

- Short, lowercase, imperative subject lines. Most use a type prefix
  (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `dx:`) or an area prefix
  (`web:`, `ingest:`, `db:`, `transcript:`). A scope such as `feat(web):` is
  also fine.
- For anything non-trivial, add a body that explains _why_, and what a
  reviewer should know (follow-ups, known breakage, ADRs).
- Run `pnpm format` and `pnpm check` before committing.
- Never commit generated or downloaded artifacts: `data/`, `models/`,
  `test-runs/`, `*.gen.*`, and `.env.local` are gitignored.
