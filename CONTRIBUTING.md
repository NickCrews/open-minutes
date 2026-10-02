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

A [pnpm](https://pnpm.io) workspace with six packages. Each depends only on
the ones listed above it:

- **[`packages/core`](packages/core)** (`@open-minutes/core`): shared domain
  code with no database or I/O: transcript and timeline types, voice-embedding
  constants, body slugs, and `.env.local` loading.
- **[`packages/db`](packages/db)** (`@open-minutes/db`): the
  [Drizzle](https://orm.drizzle.team) schema and migrations, the `pnpm db` CLI,
  and the per-test database helpers (`@open-minutes/db/testing/vitest`).
- **[`packages/fixtures`](packages/fixtures)** (`@open-minutes/fixtures`): the
  data that seeds local and test databases. `test-data/` holds the real,
  hand-verified jurisdictions, bodies, people and golden meetings. Nothing here
  ships to production.
- **[`packages/pipeline`](packages/pipeline)** (`@open-minutes/pipeline`): the
  offline ingestion pipeline and the `om` CLI. It downloads audio, transcribes
  it locally with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (NeMo
  Parakeet ASR + Silero VAD), diarizes it into speaker turns (pyannote
  segmentation + CAM++ voice embeddings), aligns turns to words, recognizes
  speakers against known voiceprints, and writes the meeting to the database.
  No GPU or external API is needed; models are downloaded on first use (or
  all at once with `pnpm om models`). See the
  [pipeline README](packages/pipeline/README.md).
- **[`packages/tools`](packages/tools)** (`@open-minutes/tools`): tools
  for editing the data (speaker labels, people, chapters), as typed tool
  definitions for agent loops and as the `pnpm tools` JSON CLI.
- **[`packages/web`](packages/web)** (`@open-minutes/web`): the public
  transcript browser, built with [SolidJS](https://www.solidjs.com) +
  [TanStack Start](https://tanstack.com/start), Kobalte and Tailwind, deployed
  to [Cloudflare Workers](https://workers.cloudflare.com).

**Database:** PostgreSQL with [pgvector](https://github.com/pgvector/pgvector)
(voiceprints are stored as vectors with an HNSW index). Locally it runs in
Docker via [`docker-compose.yml`](docker-compose.yml). Production is on
[Neon](https://neon.tech), which the Worker reaches over Neon's HTTP driver
(Workers can't open raw TCP sockets).

**Data model:** **jurisdictions** contain **bodies**, each with one or more
YouTube **video sources**. **Meetings** belong to a body, and each meeting's
transcript is a sequence of **segments** (a run of words by one speaker, with
word-level onsets). Segments are attributed to **people**, who carry a
voiceprint so they can be recognized in later meetings. A meeting may also have
**chapters**, a table of contents of titled time ranges (see
[docs/chapters.md](docs/chapters.md)). See
[`packages/db/src/schema.ts`](packages/db/src/schema.ts). The configured
bodies and video sources live in
[`packages/fixtures/test-data/`](packages/fixtures/test-data/); adding a body
means adding rows there.

Design decisions are recorded in [`adrs/`](adrs/).

## Getting started

You need:

- **Node 22** and **pnpm 10.33.0** (pinned in `package.json`;
  `corepack enable` picks it up).
- **Docker** with Compose, for the local Postgres.
- **ffmpeg**, **yt-dlp** and **[deno](https://deno.com)** on your `PATH`, for
  the pipeline and some tests (yt-dlp runs YouTube's player JS with deno).

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

## Running checks

```sh
pnpm check       # typecheck + format:check + lint + test (run this before committing)
pnpm test        # fast tests only
pnpm test:slow   # only the tests tagged `slow`
pnpm test:all    # everything, including slow tests
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

## Running the pipeline

```sh
pnpm om status          # meetings already ingested
pnpm om available       # videos not yet ingested
pnpm om ingest <id>     # run the full pipeline for a video
pnpm om models          # download every ML model up front (~650MB)
```

From a server or CI runner, YouTube answers yt-dlp with "sign in to confirm
you're not a bot". Point `YOUTUBE_COOKIES` at a cookies.txt exported from a
browser signed in to YouTube (see [`.env.example`](.env.example)); CI reads it
from the `YOUTUBE_COOKIES` secret.

`om` writes to the same database as everything else (`DB=prod pnpm om ingest <id>`
to ingest into production). See
[`packages/pipeline/README.md`](packages/pipeline/README.md) for details.

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
[`packages/tools`](packages/tools/src/tools.ts) rather than raw SQL: `pnpm
tools` lists them, and `pnpm tools <tool> '<json>'` calls one and prints JSON.
The same tools are exported from `@open-minutes/tools`, with `toAgentTool` to
hand them to an agent loop such as pi. Every write re-checks the meetings it
touched and rolls back if it introduced an error. Guidance for agents doing
this work is in
[`.claude/skills/transcript-cleanup`](.claude/skills/transcript-cleanup/SKILL.md).

`pnpm db studio` opens a browser UI on it. The pipeline's API (`listIngested`,
`listAvailable`, `ingestVideo` from `@open-minutes/pipeline/om`) and `om`'s
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
  (`web:`, `pipeline:`, `db:`, `transcript:`). A scope such as `feat(web):` is
  also fine.
- For anything non-trivial, add a body that explains _why_, and what a
  reviewer should know (follow-ups, known breakage, ADRs).
- Run `pnpm format` and `pnpm check` before committing.
- Never commit generated or downloaded artifacts: `data/`, `models/`,
  `test-runs/`, `*.gen.*`, and `.env.local` are gitignored.
