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
  connection/resolution, the declarative harness behind the `pnpm db` CLI, and
  the per-test database helpers (`@open-minutes/db/testing/vitest`).
- **[`packages/fixtures`](packages/fixtures)** (`@open-minutes/fixtures`): the
  test data (jurisdictions, bodies, people and golden meetings in `test-data/`,
  plus fictional extras in `dev-data/`), its loaders and PSV parser, and the
  `golden` and `dev` datasets that seed databases. Used by tests and by local
  development; nothing ships with it.
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
  `local`, which points at the docker-compose Postgres, in a database per git
  branch: `open_minutes__<branch>`, e.g. `open_minutes__main` on `main`. A
  detached HEAD (e.g. during `git bisect`) gets its own
  `open_minutes__detached_<commit>`. It is usually passed per command, e.g.
  `DB=prod pnpm db migrate`. To use one database on every branch instead of
  one per branch, point `DB` at it, per command or in `.env.local`:
  `DB=postgres://postgres:postgres@localhost:5432/open_minutes__main`.
- `DATABASE_URL_<NAME>` defines a named database, e.g. `DATABASE_URL_PROD`.
- `ALLOW_REMOTE_WIPE=1` is required before `pnpm db wipe` (or `pnpm db up`
  resetting or seeding) will touch a non-localhost database.

Tests always use `local`, whatever `DB` is set to.

### Database

There's nothing to set up. `pnpm dev` (and every other command that uses the
database) starts Postgres with docker compose if nothing is running, creates
this branch's database, applies pending migrations, and seeds the `dev`
dataset into a database that starts out empty. A new branch's database starts
as a copy of `main`'s, so switching branches never mixes up migrations. See
[ADR 0003](adrs/0003-declarative-database-harness.md) for the design.

`pnpm db up` is declarative: it brings a database to a schema version plus a
dataset, and does nothing if it's already there. It's what `pnpm dev` runs, and
the command you'll use most. Against a local database it takes these steps, in
order, skipping any that aren't needed:

1. **Create** the database if it doesn't exist (as a copy of `main`'s, for a
   new branch).
2. **Reset the schema** if its migration history diverged from this
   checkout's: it has migrations this checkout doesn't (e.g. from another
   branch), a migration it applied has since been edited, or it's past the
   target schema version. Resetting wipes the database, tables and data
   included, and then re-applies every migration from scratch.
   `--schema-reset never` turns this into an error instead;
   `--schema-reset always` resets every time.
3. **Migrate**: apply any pending migrations.
4. **Seed** the dataset (`dev` by default), but only if the database has no
   data at this point: it's new, was just reset, or has no rows. A database
   that already holds data keeps it, even if it's different from the declared
   dataset; `--data-reset if-needed` replaces it, and `--data-reset always`
   reseeds even the current dataset (e.g. to undo hand edits).

A remote database is never changed: `up` only checks that it has the
migrations this checkout needs.

Both `--schema-reset` and `--data-reset` take `never`, `if-needed` or
`always`. The defaults are `--schema-reset if-needed` and `--data-reset never`.

| Command                             | What it does                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `pnpm db up`                        | Steps 1-4 above                                                             |
| `pnpm db up --schema-reset never`   | The same, but errors instead of wiping when history diverged                |
| `pnpm db up --schema-reset always`  | Starts over: wipes, migrates from empty, and seeds                          |
| `pnpm db up --data golden`          | Declares the `golden` dataset instead (`--data none` for no data)           |
| `pnpm db up --data-reset if-needed` | The same, but replaces existing data that isn't the declared dataset        |
| `pnpm db up --data-reset always`    | The same, but reseeds even when the data is current                         |
| `pnpm db up --schema-version <v>`   | Brings it to an older schema version: a migration's name, timestamp, or tag |

The imperative commands each do one thing:

| Command            | What it does                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db generate` | Generates a migration from `packages/db/src/schema.ts` changes                                                                            |
| `pnpm db migrate`  | Moves forward: applies pending migrations (up to `--schema-version`) and nothing else; stops if history diverged. What `pnpm deploy` runs |
| `pnpm db wipe`     | Moves back to empty: drops the tables, migration history, and data                                                                        |

`up` migrates forward when it can and wipes only when it has to, so it keeps
your data. To start over completely, whatever state the database is in:

```sh
pnpm db up --schema-reset always
```

And the rest:

| Script           | What it does                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm db status` | Which schema version and dataset a database holds, and any pending migrations                   |
| `pnpm db prune`  | Lists (with `--yes`, drops) databases of deleted branches, leaked test databases, old templates |
| `pnpm db check`  | Checks the migrations for conflicts                                                             |
| `pnpm db studio` | Opens Drizzle Studio                                                                            |

`pnpm db --help` lists the full CLI. The datasets live in `packages/fixtures`,
and `dbranch.config.ts` at the repository root tells the CLI which ones
`--data` can name and which one `pnpm db up` seeds by default.

Migrations live in `packages/db/src/migrations/` and are committed. After
you edit `schema.ts`, run `pnpm db generate` and commit the generated migration
with the change. A migration that transforms existing data gets a test in
`packages/db/src/migration-tests/`.

## Repo layout

```
packages/
  core/       @open-minutes/core: transcription, timeline and voice-embedding types,
              body slugs, .env.local loading
  db/         @open-minutes/db: DB schema, migrations, connection resolution, the
              declarative harness and `pnpm db` CLI, test databases
  fixtures/   @open-minutes/fixtures: test data and golden meetings in test-data/,
              fictional extras in dev-data/, the PSV parser, and the datasets
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
pnpm dev       # runs `pnpm db up`, then starts the web dev server
pnpm web:dev   # just the web dev server: migrates the schema but doesn't seed data
```

This serves the app at http://localhost:3000 against the `local` database by
default. `DB=<name> pnpm dev` points it elsewhere; a remote database is only
checked, never migrated or seeded. Editing affordances (e.g. renaming a person)
are enabled only in dev.

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
