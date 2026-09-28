# Contributing to Open Minutes

## Vocabulary

Terms like _body_, _meeting_, _segment_, _speaker_, and _person_ have specific
meanings here. See the glossary in [`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md)
and use those terms in code, comments, and commit messages.

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
pnpm db:seed                  # load fixtures from packages/pipeline/test-data/
```

The other database scripts:

| Script             | What it does                                                                     |
| ------------------ | -------------------------------------------------------------------------------- |
| `pnpm db:reset`    | `db:nuke` then `db:seed`: a clean, migrated, seeded database                     |
| `pnpm db:nuke`     | Starts Postgres if needed, drops the `public` and `drizzle` schemas, re-migrates |
| `pnpm db:generate` | Generates a migration from `packages/core/src/db/schema.ts` changes              |
| `pnpm db:studio`   | Opens Drizzle Studio                                                             |

Migrations live in `packages/core/src/db/migrations/` and are committed. After
you edit `schema.ts`, run `pnpm db:generate` and commit the generated migration
with the change.

## Repo layout

```
packages/
  core/       @open-minutes/core: DB schema, migrations and connection resolution;
              YouTube (yt-dlp), bodies, transcription and voice-embedding types
  pipeline/   @open-minutes/pipeline: offline audio → transcript pipeline
              (transcribe, diarize, align, identify), the `om` CLI, db seeding,
              golden test fixtures in test-data/. See packages/pipeline/README.md.
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
pnpm web:dev
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
