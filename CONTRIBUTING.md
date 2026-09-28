# Contributing to Open Minutes

This is the technical guide: how Open Minutes works, how to run it, and how to
work with its data directly. For what the project is and who it's for, see the
[README](README.md).

## Vocabulary

Terms like _body_, _meeting_, _segment_, _speaker_, and _person_ have specific
meanings here. See [`TERMINOLOGY.md`](TERMINOLOGY.md) and use those terms in
code, comments, and commit messages.

## How it works

A [pnpm](https://pnpm.io) workspace with five packages. Each depends only on
the ones listed above it:

- **[`packages/core`](packages/core)** (`@open-minutes/core`): shared domain
  code with no database or I/O: transcript and timeline types, voice-embedding
  constants, body slugs, and root `.env.local` loading.
- **[`packages/db`](packages/db)** (`@open-minutes/db`): the
  [Drizzle](https://orm.drizzle.team) schema and migrations, database
  connection/resolution, the `db:*` scripts, and the per-test database helpers
  (`@open-minutes/db/testing/vitest`).
- **[`packages/fixtures`](packages/fixtures)** (`@open-minutes/fixtures`): the
  test data (jurisdictions, bodies, people and golden meetings in
  `test-data/`), its loaders and PSV parser, and the database seeder. Used by
  tests and by local development; nothing ships with it.
- **[`packages/pipeline`](packages/pipeline)** (`@open-minutes/pipeline`): the
  offline ingestion pipeline and the `om` CLI. It downloads audio, transcribes
  it locally with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (NeMo
  Parakeet ASR + Silero VAD), diarizes it into speaker turns (pyannote
  segmentation + CAM++ voice embeddings), aligns turns to words, recognizes
  speakers against known voiceprints, and writes the meeting to the database.
  No GPU or external API is needed; models are downloaded on first use. Also
  holds the YouTube boundary (via `yt-dlp`). See the
  [pipeline README](packages/pipeline/README.md).
- **[`packages/web`](packages/web)** (`@open-minutes/web`): the public
  transcript browser, built with [SolidJS](https://www.solidjs.com) +
  [TanStack Start](https://tanstack.com/start), Kobalte and Tailwind.

**Database:** PostgreSQL with [pgvector](https://github.com/pgvector/pgvector)
(voiceprints are stored as vectors with an HNSW index). Locally it runs in
Docker via [`docker-compose.yml`](docker-compose.yml). For a hosted database
the web app supports [Neon](https://neon.tech), which it reaches over Neon's
HTTP driver (Workers can't open raw TCP sockets).

**Deploy target:** the web app deploys to
[Cloudflare Workers](https://workers.cloudflare.com) (worker `open-minutes`,
configured in [`packages/web/wrangler.jsonc`](packages/web/wrangler.jsonc)) via
`pnpm --filter @open-minutes/web run deploy`. The pipeline runs offline on a
developer machine and writes to the target database directly.

```
YouTube ──yt-dlp──▶ pipeline (om ingest) ──▶ Postgres + pgvector ◀── web (Cloudflare Workers)
                    transcribe / diarize /       (local Docker or Neon)
                    align / recognize
```

The data model: **jurisdictions** contain **bodies**, each with one or more
YouTube **video sources**. **Meetings** belong to a body, and each meeting's
transcript is a sequence of **segments** (a run of words by one speaker, with
word-level onsets). Segments are attributed to **people**, who carry a
voiceprint so they can be recognized in later meetings. See
[`packages/db/src/schema.ts`](packages/db/src/schema.ts). The
configured bodies and video sources live in the test data under
[`packages/fixtures/test-data/`](packages/fixtures/test-data/); adding a body
means adding rows there.

## Local setup

### Prerequisites

- **Node 22** and **pnpm 10.33.0** (pinned via `packageManager` in
  `package.json`; `corepack enable` picks it up).
- **Docker** with Compose, for the local Postgres (pgvector) database.
- **ffmpeg** and **yt-dlp** on your `PATH`. The pipeline and some tests shell
  out to them.
- **curl** and network access the first time the pipeline runs: sherpa-onnx
  models are downloaded on demand into `packages/pipeline/src/models/`
  (gitignored).

### Install

```sh
pnpm install
```

### Environment variables

No configuration is required for local development. Environment is read from a
workspace-root `.env.local` (gitignored); see [`.env.example`](.env.example)
for the available variables:

- `DB` selects the target database: a name such as `local` or `prod`, resolved
  via `DATABASE_URL_<NAME>`, or a full `postgres://` URL. It defaults to
  `local`, which points at the docker-compose Postgres
  (`postgres://postgres:postgres@localhost:5432/open_minutes`). It is usually
  passed per command, e.g. `DB=prod pnpm db:migrate`.
- `DATABASE_URL_<NAME>` defines a named database, e.g. `DATABASE_URL_PROD`.
- `ALLOW_REMOTE_NUKE=1` is required before `db:nuke`/`db:reset` will touch a
  non-localhost database.

Tests always use `local`, whatever `DB` is set to.

### Database

```sh
pnpm db:up                    # start Postgres (docker-compose.yml)
pnpm db:migrate               # apply migrations
pnpm db:seed                  # load the test data from packages/fixtures/test-data/
```

The other database scripts:

| Script             | What it does                                                                     |
| ------------------ | -------------------------------------------------------------------------------- |
| `pnpm db:reset`    | `db:nuke` then `db:seed`: a clean, migrated, seeded database                     |
| `pnpm db:nuke`     | Starts Postgres if needed, drops the `public` and `drizzle` schemas, re-migrates |
| `pnpm db:generate` | Generates a migration from `packages/db/src/schema.ts` changes                   |
| `pnpm db:studio`   | Opens Drizzle Studio                                                             |

Migrations live in `packages/db/src/migrations/` and are committed. After
you edit `schema.ts`, run `pnpm db:generate` and commit the generated migration
with the change.

## Repo layout

```
packages/
  core/       @open-minutes/core: transcription, timeline and voice-embedding types,
              body slugs, .env.local loading
  db/         @open-minutes/db: DB schema, migrations, connection resolution,
              test databases
  fixtures/   @open-minutes/fixtures: test data and golden meetings in test-data/,
              the PSV parser, and db seeding
  pipeline/   @open-minutes/pipeline: offline audio → transcript pipeline
              (transcribe, diarize, align, recognize), YouTube (yt-dlp), and the
              `om` CLI. See packages/pipeline/README.md.
  web/        @open-minutes/web: transcript browser (SolidStart + TanStack Router,
              Kobalte, Tailwind), deployed to Cloudflare Workers
adrs/         Architecture Decision Records
```

Root-level `vitest.config.ts`, `vitest.shared.ts`, and `test-setup.ts` hold the
shared test configuration for every package.

## Running checks

```sh
pnpm check       # typecheck + format:check + lint + test (run this before committing)
pnpm test        # fast tests only
pnpm test:slow   # only the tests tagged `slow`
pnpm test:all    # everything, including slow tests
pnpm format      # prettier --write over the repo
```

Tests that need a database create their own disposable databases on the local
Postgres, starting the docker-compose service themselves if nothing is
listening. Tests tagged `slow` run full-meeting transcription and diarization
and take roughly 10–20 minutes each on CPU. They are skipped unless `SLOW=1`,
which `test:slow` and `test:all` set for you.

## Web dev server

```sh
pnpm dev       # start the local Postgres, then the web dev server
pnpm web:dev   # just the web dev server
```

This serves the app at http://localhost:3000 against the `local` database by
default (`DB=<name> pnpm web:dev` to point it elsewhere), so migrate and seed
first. Editing affordances (e.g. renaming a person) are enabled only in dev.

## Running the pipeline

```sh
pnpm om status          # meetings already ingested
pnpm om available       # videos not yet ingested
pnpm om ingest <id>     # run the full pipeline for a video
```

See [`packages/pipeline/README.md`](packages/pipeline/README.md) for details.

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

The pipeline's API (`listIngested`, `listAvailable`, `ingestVideo` from
`@open-minutes/pipeline/om`) and `om`'s JSON output (`om status --json`) are
designed to be composed.

## Architecture Decision Records

Significant design decisions are recorded in [`adrs/`](adrs/) as numbered
Markdown files: `NNNN-short-kebab-title.md`. Follow the format of the existing
ADRs:

- A `# ADR NNNN: Title` heading, followed by `Date:` and
  `Status:` (`Proposed` or `Accepted`) lines.
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
