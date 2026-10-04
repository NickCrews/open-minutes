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

A [pnpm](https://pnpm.io) workspace with nine packages. Each depends only on
the ones listed above it:

- **[`packages/core`](packages/core)** (`@open-minutes/core`): shared domain
  code with no database or I/O: transcript and timeline types, transcript
  cleaning and speaker alignment, word error rate, chapter rules, reading a
  meeting's date from its title and transcript, the interface a video site
  implements, voice-embedding constants, body slugs, and `.env.local` loading.
- **[`packages/db`](packages/db)** (`@open-minutes/db`): the
  [Drizzle](https://orm.drizzle.team) schema and migrations, the `pnpm db` CLI,
  and the per-test database helpers (`@open-minutes/db/testing/vitest`).
- **[`packages/fixtures`](packages/fixtures)** (`@open-minutes/fixtures`): the
  data that seeds local and test databases. `test-data/` holds the real,
  hand-verified jurisdictions, bodies, people and golden meetings. Nothing here
  ships to production.
- **[`packages/audio`](packages/audio)** (`@open-minutes/audio`): speech
  processing, run locally with
  [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). It transcribes a WAV
  (NeMo Parakeet ASR + Silero VAD) and diarizes it into speaker turns (pyannote
  segmentation + CAM++ voice embeddings). No GPU or external API is needed;
  models are downloaded on first use (or all at once with `pnpm om models`).
  See the [audio README](packages/audio/README.md).
- **[`packages/youtube`](packages/youtube)** (`@open-minutes/youtube`): the
  YouTube source. It lists a channel's or playlist's videos and gets a video's
  metadata and audio, with yt-dlp or from the object store (see below), and
  decodes YouTube's Opus audio to WAV. See the
  [youtube README](packages/youtube/README.md).
- **[`packages/akleg`](packages/akleg)** (`@open-minutes/akleg`): the source
  for the Alaska Legislature's meetings on akleg.gov, a peer of the YouTube
  source. It lists a committee's recorded meetings and gets a meeting's
  metadata and audio, decoding its MP3 to WAV. See the
  [akleg README](packages/akleg/README.md).
- **[`packages/ingest`](packages/ingest)** (`@open-minutes/ingest`): the
  offline ingestion pipeline. It gets a meeting's audio from
  `@open-minutes/youtube` or `@open-minutes/akleg`, runs it through `@open-minutes/audio`, aligns turns to words, recognizes speakers
  against known voiceprints, and writes the meeting to the database. See the
  [ingest README](packages/ingest/README.md).
- **[`packages/agents`](packages/agents)** (`@open-minutes/agents`): the
  interface for agents and people. Tools for editing the data (speaker
  labels, people, chapters) as typed tool definitions for agent loops, and
  the `om` CLI: `om ingest` and friends over `@open-minutes/ingest`,
  `om models`, and `om tools`, the tools as a JSON CLI.
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
committee) that is scanned for new meetings. **Meetings** belong to a body,
and record the site they were published on (YouTube or akleg.gov), and each meeting's
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
- **yt-dlp** and **[deno](https://deno.com)** on your `PATH`, for videos not
  yet in the object store (below); yt-dlp runs YouTube's player JS with deno.

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
that. Migrations must be backward-compatible, since old code briefly runs on
the new schema.

See [docs/contributing/deploy.md](docs/contributing/deploy.md) for the details
and one-time setup.

## Running checks

```sh
pnpm check       # typecheck + format:check + lint + test (run this before committing)
pnpm test        # fast tests only
pnpm test:slow   # only the tests tagged `slow`
pnpm test:all    # everything, including slow tests
pnpm bench       # time the audio models per minute of audio (*.bench.ts)
pnpm format      # prettier --write over the repo
```

Tests that need a database clone a cached, pre-seeded template. Tests
tagged `slow` run full-meeting transcription and diarization and take roughly
10–20 minutes each on CPU. They're skipped unless `SLOW=1`, which `test:slow`
and `test:all` set for you.

Shared test configuration is in `vitest.config.ts`, `vitest.shared.ts` and
`test-setup.ts` at the repository root.

### Checking hand-edited test data

`pnpm fixtures:check` checks the files in `packages/fixtures/test-data/` and
prints each problem as `file:line: severity: message`. Pass
file paths to check only the meetings they belong to. Errors are data that is
wrong, such as a speaker marker a line away from its first word, words out of
time order, or overlapping chapters. Warnings are data that breaks a
convention or is probably wrong, such as a chapter outside the size
conventions or speech that no chapter covers. The test suite fails on either.

[`.claude/settings.json`](.claude/settings.json) runs the same check as a
Claude Code hook after every edit to those files, so an agent sees the
problem on the turn it makes it.

### Transcript cleaning

The recognizer transcribes verbatim, so `om ingest` runs a **clean** stage
right after transcription that strips disfluencies: filler words ("um",
"uh"), stuttered function words ("the the"), and abandoned word fragments
("six- sixteen"). The rules live in
[`packages/core/src/transcription/clean.ts`](packages/core/src/transcription/clean.ts);
the cached `transcription.json` stays verbatim, so a rule change applies on
the next run without re-transcribing.

Golden transcripts must already be clean, or the pipeline's output would be
scored against disfluencies it removed on purpose. `pnpm fixtures:check`
reports any left in a golden as an error, so the tests and the hook above
catch them in new goldens too. To remove them:

```sh
pnpm fixtures:clean              # rewrite every golden transcript in place
pnpm fixtures:clean <file.psv>   # just one file (--verbose lists each word)
```

To add a cleanup, write a rule in `clean.ts`, add it to `CLEANING_RULES` with
tests, then run `pnpm fixtures:clean` and review the golden diff.

## Running the pipeline

```sh
pnpm om status          # meetings already ingested
pnpm om available       # meetings not yet ingested, on bodies' meeting sources
pnpm om ingest <id>     # run the full pipeline for a meeting
pnpm om models          # download every ML model up front (~650MB)
```

From a server or CI runner, YouTube answers yt-dlp with "sign in to confirm
you're not a bot". Metadata and audio come from the object store instead: the
project's S3-compatible bucket (Cloudflare R2), public at
`OBJECT_STORE_PUBLIC_URL`, where the
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

`om` (in [`packages/agents`](packages/agents/src/cli/om.ts)) writes to the
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

To change the data, agents (and people) use the tools in
[`packages/agents`](packages/agents/src/tools.ts) rather than raw SQL: `pnpm om
tools` lists them, and `pnpm om tools <tool> '<json>'` calls one and prints
JSON. The same tools are exported from `@open-minutes/agents`, with `toAgentTool` to
hand them to an agent loop such as pi. Every write re-checks the meetings it
touched and rolls back if it introduced an error. Guidance for agents doing
this work is in
[`.claude/skills/transcript-cleanup`](.claude/skills/transcript-cleanup/SKILL.md).

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
