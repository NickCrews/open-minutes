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

A [pnpm](https://pnpm.io) workspace with five packages. Each depends only on
the ones listed above it:

- **[`packages/core`](packages/core)** (`@open-minutes/core`): shared domain
  code with no database or I/O: transcript and timeline types, voice-embedding
  constants, body slugs, and `.env.local` loading.
- **[`packages/db`](packages/db)** (`@open-minutes/db`): the
  [Drizzle](https://orm.drizzle.team) schema and migrations, the `pnpm db` CLI,
  and the per-test database helpers (`@open-minutes/db/testing/vitest`).
- **[`packages/fixtures`](packages/fixtures)** (`@open-minutes/fixtures`): the
  data that seeds local and test databases. `test-data/` holds the real,
  hand-verified jurisdictions, bodies, people and golden meetings; `dev-data/`
  holds fictional extras. Nothing here ships to production.
- **[`packages/pipeline`](packages/pipeline)** (`@open-minutes/pipeline`): the
  offline ingestion pipeline and the `om` CLI. It downloads audio, transcribes
  it locally with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (NeMo
  Parakeet ASR + Silero VAD), diarizes it into speaker turns (pyannote
  segmentation + CAM++ voice embeddings), aligns turns to words, recognizes
  speakers against known voiceprints, and writes the meeting to the database.
  No GPU or external API is needed; models are downloaded on first use. See the
  [pipeline README](packages/pipeline/README.md).
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
voiceprint so they can be recognized in later meetings. See
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
- **ffmpeg** and **yt-dlp** on your `PATH`, for the pipeline and some tests.

Then:

```sh
pnpm install
pnpm dev       # http://localhost:3000
```

That's all. `pnpm dev` starts Postgres in Docker if it isn't running, creates
and migrates a database for your git branch, fills it with sample data, and
starts the web dev server. Editing affordances (e.g. renaming a person) are
enabled only in dev. `pnpm web:dev` starts only the dev server: it creates and
migrates the database too, but doesn't seed it.

No configuration is needed for local development. Optional settings go in a
gitignored `.env.local` at the repository root; see
[`.env.example`](.env.example).

## The database

### Which database you're using

Every command that touches the database (`pnpm dev`, `pnpm db …`, `om …`)
picks its target the same way: the `--db` flag if the command has one, else the
`DB` environment variable, else `local`. The value is either a name or a full
`postgres://` URL:

- **`local`** (the default) is a database on the docker-compose Postgres,
  **one per git branch**: `open_minutes__<branch>`, e.g. `open_minutes__main`.
  A new branch's database starts as a copy of `main`'s, so it begins with the
  data you already had, and switching branches never mixes up migrations.
- **Any other name**, e.g. `prod`, is read from `DATABASE_URL_<NAME>`, e.g.
  `DATABASE_URL_PROD` in `.env.local`.

Databases on `localhost` are **local** and treated as disposable. Anything else
is **remote**, and the tooling won't wipe or seed it (see
[Remote databases](#remote-databases)).

To use one database on every branch instead of one per branch, set `DB` to its
URL in `.env.local`, e.g.
`DB=postgres://postgres:postgres@localhost:5432/open_minutes__main`.

Tests ignore all of this: they always create their own throwaway databases on
the local Postgres.

### Common tasks

| I want to…                                             | Run                                               |
| ------------------------------------------------------ | ------------------------------------------------- |
| Get my branch's database up to date                    | `pnpm db up` (`pnpm dev` does this for you)       |
| See what state a database is in                        | `pnpm db status`                                  |
| Start over with a fresh database and fresh sample data | `pnpm db up --schema-reset always`                |
| Throw away my edits to the sample data                 | `pnpm db up --data-reset always`                  |
| Use the small `golden` dataset instead of `dev`        | `pnpm db up --data golden --data-reset if-needed` |
| Get an empty, migrated database with no data           | `pnpm db up --schema-reset always --data none`    |
| Change the schema                                      | edit `schema.ts`, then `pnpm db generate`         |
| Deploy the web app (migrates prod first)               | `pnpm run deploy`                                 |
| Clean up databases of deleted branches                 | `pnpm db prune`, then `pnpm db prune --yes`       |

`pnpm db --help` and `pnpm db <command> --help` describe every command and
flag.

### `pnpm db up`: make it match this checkout

`up` is the command you'll use most, and the one `pnpm dev` runs. You tell it
the state you want: a schema (latest, by default) and a dataset (`dev`, by
default). It gets the database there, changing as little as possible, and does
nothing if the database is already there.

On a local database it does these steps in order, skipping any that aren't
needed:

1. **Create** the database, as a copy of `main`'s for a new branch.
2. **Reset the schema** if the database can't be migrated forward: it has
   migrations this checkout doesn't (usually another branch's), a migration it
   already applied has since been edited, or it's already past the target
   version. A reset **deletes everything**, tables and data, then applies every
   migration from scratch.
3. **Migrate**: apply pending migrations.
4. **Seed** the dataset, but only if the database has no data: it's new, was
   just reset, or its tables are empty. Data already there is kept, even if it
   isn't the declared dataset.

On a remote database it changes nothing: it only checks that the database has
every migration this checkout needs, and fails if not.

Two flags control the destructive steps, 2 and 4. Each takes `never`,
`if-needed` or `always`:

| Flag             | `never`                                        | `if-needed`                                                    | `always`                                   |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| `--schema-reset` | Error instead of resetting                     | **Default.** Reset only when step 2 says it can't migrate      | Reset every time: start over from empty    |
| `--data-reset`   | **Default.** Seed only a database with no data | Also replace data that isn't the declared dataset, or is stale | Reseed every time, e.g. to undo hand edits |

And two choose the target state:

| Flag               | Values                                                                                                 | Default  |
| ------------------ | ------------------------------------------------------------------------------------------------------ | -------- |
| `--data`           | `dev`, `golden`, or `none`                                                                             | `dev`    |
| `--schema-version` | `latest`, or a migration by folder name, timestamp or tag, e.g. `20260719061307` or `panoramic_dagger` | `latest` |

`--data` other than `none` needs `--schema-version latest`, since the seeders
write the current schema. An older `--schema-version` therefore defaults to
`--data none`.

The datasets are:

- **`dev`**: what `pnpm dev` runs on. The golden rows, the golden meetings'
  full transcripts and people, and fictional extras from
  `packages/fixtures/dev-data/` ("Demo County"). Voiceprints are placeholders.
- **`golden`**: only the hand-verified rows from
  `packages/fixtures/test-data/` (jurisdictions, bodies, video sources), as
  evals and tests see them.

[`dbranch.config.ts`](dbranch.config.ts) at the repository root lists the
datasets `--data` can name and picks the default.

### The other commands

Unlike `up`, these each do exactly one thing:

| Command            | What it does                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db migrate`  | Applies pending migrations (up to `--schema-version`) and nothing else. Never resets or seeds; if the database can't be migrated forward, it fails. Safe on production: it's what deploys run. |
| `pnpm db wipe`     | Empties a database: drops its tables, migration history and data. The next `up` rebuilds it.                                                                                                   |
| `pnpm db status`   | Shows the database's schema version, which dataset it holds and whether that's current, and any pending or unexpected migrations. `--check` exits non-zero if it needs migrating.              |
| `pnpm db generate` | Writes a new migration from your `schema.ts` changes.                                                                                                                                          |
| `pnpm db check`    | Checks the migrations for conflicts.                                                                                                                                                           |
| `pnpm db studio`   | Opens Drizzle Studio on the database.                                                                                                                                                          |
| `pnpm db prune`    | Lists local databases nothing needs: those of deleted branches, leftovers from interrupted test runs, and outdated test templates. `--yes` drops them.                                         |

`migrate`, `wipe`, `status`, `studio` and `up` all take `--db`.

### Remote databases

Nothing wipes or seeds a remote database by accident:

- `pnpm db up`, `pnpm dev` and `om` only check a remote database's schema.
  They fail if it's missing migrations, rather than migrating it.
- `pnpm db migrate --db prod` is the only command that changes production, and
  it only applies new migrations.
- `pnpm db wipe` refuses a remote database unless `ALLOW_REMOTE_WIPE=1`.

`pnpm run deploy` runs `pnpm db migrate --db prod`, then deploys the Worker, so
production code never runs on a schema older than it expects. The old code
does briefly run on the new schema, so migrations must be backward-compatible:
add first, deploy, and remove in a later change.

### Changing the schema

1. Edit [`packages/db/src/schema.ts`](packages/db/src/schema.ts).
2. Run `pnpm db generate`, which writes a migration to
   `packages/db/src/migrations/`. Commit it with your change. CI fails if
   `schema.ts` has changes with no migration.
3. Run `pnpm db up` (or restart `pnpm dev`) to apply it.

If the migration transforms existing data, rather than only changing tables,
give it a test in
[`packages/db/src/migration-tests/`](packages/db/src/migration-tests/): seed
rows at the schema version before it, migrate, and check the result. The
existing tests there show how.

Once a migration is on `main`, don't edit it; add a new one. On your own
branch, editing an unmerged migration is fine: `pnpm db up` notices and
resets your branch's database.

## Running checks

```sh
pnpm check       # typecheck + format:check + lint + test (run this before committing)
pnpm test        # fast tests only
pnpm test:slow   # only the tests tagged `slow`
pnpm test:all    # everything, including slow tests
pnpm format      # prettier --write over the repo
```

Tests that need a database clone a cached, pre-seeded template on the local
Postgres, starting the docker-compose service if nothing is listening. Tests
tagged `slow` run full-meeting transcription and diarization and take roughly
10–20 minutes each on CPU. They're skipped unless `SLOW=1`, which `test:slow`
and `test:all` set for you.

Shared test configuration is in `vitest.config.ts`, `vitest.shared.ts` and
`test-setup.ts` at the repository root.

## Running the pipeline

```sh
pnpm om status          # meetings already ingested
pnpm om available       # videos not yet ingested
pnpm om ingest <id>     # run the full pipeline for a video
```

`om` writes to the same database as everything else (`DB=prod om ingest <id>`
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

`pnpm db studio` opens a browser UI on it. The pipeline's API (`listIngested`,
`listAvailable`, `ingestVideo` from `@open-minutes/pipeline/om`) and `om`'s
JSON output (`om status --json`) are designed to be composed.

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
