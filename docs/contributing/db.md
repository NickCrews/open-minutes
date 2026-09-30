# The database

How Open Minutes' databases work in development, tests and production, and the
`pnpm db` CLI that manages them. [How it works](#how-it-works) at the end
explains the design and why it's built this way.

You usually don't need any of this: `pnpm dev` sets up your database for you.
Read on when you want to reset it, switch datasets, change the schema, or
touch production.

## Which database you're using

Every command that touches the database (`pnpm dev`, `pnpm db …`, `pnpm om …`)
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

## Common tasks

| I want to…                                             | Run                                               |
| ------------------------------------------------------ | ------------------------------------------------- |
| Get my branch's database up to date                    | `pnpm db up` (`pnpm dev` does this for you)       |
| See what state a database is in                        | `pnpm db status`                                  |
| Start over with a fresh database and fresh sample data | `pnpm db up --schema-reset always`                |
| Throw away my edits to the sample data                 | `pnpm db up --data-reset always`                  |
| Use the small `golden` dataset instead of `dev`        | `pnpm db up --data golden --data-reset if-needed` |
| Get an empty, migrated database with no data           | `pnpm db up --schema-reset always --data none`    |
| Change the schema                                      | edit `schema.ts`, then `pnpm db generate`         |
| Deploy the web app (migrates prod first)               | `pnpm deploy:prod`                                |
| Clean up databases of deleted branches                 | `pnpm db prune`, then `pnpm db prune --yes`       |

`pnpm db --help` and `pnpm db <command> --help` describe every command and
flag.

## `pnpm db up`: make it match this checkout

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

[`dbranch.config.ts`](../../dbranch.config.ts) at the repository root lists the
datasets `--data` can name and picks the default. It's the only place that
connects the `pnpm db` CLI to the data: `@open-minutes/db` imports no datasets
itself, so packages depend pipeline → fixtures → db → core and never back. The
CLI uses the nearest `dbranch.config.ts` at or above the directory it's run
from (`DBRANCH_CONFIG` overrides that).

The datasets live in `packages/fixtures/src/seed/`. Seeders assign ids
explicitly, so a fixture always gets the same ids (and URLs), then advance the
id sequences past them so the app's own inserts don't collide.

## The other commands

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

## Remote databases

Nothing wipes or seeds a remote database by accident:

- `pnpm db up`, `pnpm dev` and `om` only check a remote database's schema.
  They fail if it's missing migrations, rather than migrating it.
- `pnpm db migrate --db prod` is the only command that changes production, and
  it only applies new migrations.
- `pnpm db wipe` refuses a remote database unless `ALLOW_REMOTE_WIPE=1`.

`pnpm deploy:prod` runs `pnpm db migrate --db prod`, then deploys the Worker, so
production code never runs on a schema older than it expects. The old code
does briefly run on the new schema, so migrations must be backward-compatible:
add first, deploy, and remove in a later change.

## Changing the schema

1. Edit [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts).
2. Run `pnpm db generate`, which writes a migration to
   `packages/db/src/migrations/`. Commit it with your change. CI fails if
   `schema.ts` has changes with no migration.
3. Run `pnpm db up` (or restart `pnpm dev`) to apply it.

If the migration transforms existing data, rather than only changing tables,
give it a test in
[`packages/db/src/migration-tests/`](../../packages/db/src/migration-tests/).
Start a database at the schema version just before your migration, seed it with
rows shaped like production's, migrate, and check the result:

```ts
const test = dbTest({
  schemaVersion: "panoramic_dagger", // the migration just before yours
  data: sqlData("legacy", `INSERT INTO municipalities ...`),
});

test("splits municipalities", async ({ testDb }) => {
  await testDb.migrateTo("split-munis-into-jurisdictions-and-bodies");
  // ...check the data was translated correctly, with raw SQL on testDb.client
});
```

Use raw SQL, not drizzle's table objects, which only describe the latest
schema. Because both ends are pinned to named versions, the test stays valid as
later migrations pile up.

Once a migration is on `main`, don't edit it; add a new one. On your own
branch, editing an unmerged migration is fine: `pnpm db up` notices and
resets your branch's database.

## Databases in tests

Tests never use your branch's database. Each test that needs one gets its own
throwaway copy of a template database, which takes tens of milliseconds:

```ts
import { dbTest } from "@open-minutes/db/testing/vitest";
import { goldenData } from "@open-minutes/fixtures/golden-data";

const test = dbTest({ data: goldenData });

test("…", async ({ testDb }) => {
  // testDb starts at the latest schema with the golden rows
});
```

`dbTest` takes the same `schemaVersion` and `data` as `pnpm db up`. Each
(schema version, dataset) pair gets its own template, built once and rebuilt
only when the migrations or the dataset change. The pipeline's tests use
`goldenTest`, which is `dbTest({ data: goldenData })` plus helpers. The e2e
recognition test uses `goldenMeetingsData(slugs)` (in
`packages/pipeline/src/seed/`), which adds golden meetings with real
voiceprints. Computing those embeds hundreds of MB of audio, so it happens once
per change to the fixtures or the embedding model, and later runs reuse the
template. Pass `setupTimeoutMs` to `dbTest` for slow datasets like that one.

## How it works

### Why

Before this setup, you brought the database up to date by hand, and every
branch shared one local database. Migrating on a feature branch and switching
back to `main` left `main`'s code on a schema it didn't know. drizzle records
applied migrations only by name, so it didn't notice, and things broke later in
confusing ways. Worktrees, agent sessions and CI each also need a database that
doesn't disturb the others.

So every database, local or remote, dev or test, is brought to a **declared
state** by one function, `ensureDatabase` in
[`packages/db/src/ensure.ts`](../../packages/db/src/ensure.ts), and local
databases are per branch.

### Declared state

A declared state is a schema version plus an optional dataset. `schema.ts` is
the source of truth for the schema, `pnpm db generate` turns changes into
reviewed SQL migrations, and the harness applies those. It never diffs
`schema.ts` against a live database. Migrations are append-only, so a schema
version names the same schema forever.

A dataset has a name, a fingerprint, and a function that writes its rows. The
harness records the fingerprint it last applied in the database, which is how
`status` and `--data-reset if-needed` know whether the data is current.

### Detecting drift

The harness compares drizzle's journal with the migration files on disk by
name **and** hash, so it can tell:

- **pending**: in this checkout, not yet applied;
- **unknown**: applied, but not in this checkout, e.g. another branch's;
- **modified**: applied, then edited.

Pending migrations are applied. Unknown or modified ones mean the history
diverged: `up` resets a local database, and anything else stops with an error.

A per-database Postgres advisory lock means two processes starting at once
(two dev servers, parallel CI jobs) migrate only once. Neon `-pooler` URLs are
switched to the direct host, since the pooler can leave advisory locks stuck.

### Per-branch databases

`local` resolves to `open_minutes__<branch>`, read from `.git/HEAD`, so it works
in worktrees. `main` and `master` share `open_minutes__main`. In the middle of a
rebase, the branch being rebased is used. Any other detached HEAD (`git
bisect`, an old commit, a tag) gets `open_minutes__detached_<commit>`.
Otherwise old code would see `main`'s newer migrations as divergence and reset
`main`'s database.

A new branch's database is created as a copy of `open_minutes__main`. If
`main`'s database is in use, which blocks copying, it's created empty and
seeded instead. The plain `open_minutes` database is left as docker-compose's
empty default. If it holds data from before per-branch databases, it's renamed
to `open_minutes__main` on first use, so that data carries over.

### Where it runs

Everything that uses a database runs the harness first, so they all agree on
what "ready" means:

- **`pnpm dev`** runs `pnpm db up`.
- **`pnpm web:dev`**: a Vite plugin
  ([`packages/web/vite/dev-database.ts`](../../packages/web/vite/dev-database.ts))
  creates and migrates the database but doesn't seed it, then passes its URL to
  the Worker. workerd can't read `.env.local` or `.git`, so it can't work out
  the database itself.
- **`om`** runs it before every command, so `om ingest` on a new branch just
  works, and `DB=prod om ingest` fails fast if production is behind.
- **Tests** build their templates with it.
- **`pnpm deploy:prod`** runs `pnpm db migrate --db prod` before deploying.
- **CI** ([`.github/workflows/db.yml`](../../.github/workflows/db.yml)) starts
  Postgres the way a developer's machine does, then checks the migrations for
  conflicts, checks that `schema.ts` has no changes without a migration, builds
  a fresh database with `up` (twice: the second must do nothing), wipes it,
  rebuilds it with `migrate`, and runs the database tests.

On a local database the harness can create, migrate, reset and seed. On a
remote one it only checks, except for `migrate`, which only moves forward.

The deployed Worker doesn't check its schema at runtime: that would add a
query to every cold start. Migrating before deploying, plus `pnpm db status
--check`, covers it instead.
