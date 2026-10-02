# The database

How Open Minutes' databases work in development, tests and production, and the
`pnpm db` CLI that manages them.

`pnpm dev` sets up your database for you. Read on to reset it, switch
datasets, change the schema, or touch production.

## Which database you're using

Every command that touches the database picks its target the same way: the
`--db` flag, else the `DB` environment variable, else `local`. The value is a
name or a `postgres://` URL:

- **`local`** (the default) is a database on the docker-compose Postgres,
  **one per git branch**: `open_minutes__<branch>`, e.g. `open_minutes__main`.
  A new branch's database starts as a copy of `main`'s.
- **Any other name**, e.g. `prod`, is read from `DATABASE_URL_<NAME>` in
  `.env.local`.

Databases on `localhost` are **local** and treated as disposable. Anything else
is **remote**, and the tooling won't wipe or seed it (see
[Remote databases](#remote-databases)).

To use one database on every branch, set `DB` to its URL in `.env.local`, e.g.
`DB=postgres://postgres:postgres@localhost:5432/open_minutes__main`.

Tests ignore all of this and create their own throwaway databases.

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

`up`, which `pnpm dev` runs, takes the state you want: a schema (default
latest) and a dataset (default `dev`). It gets the database there, changing as
little as possible. On a local database it does these steps in order, skipping
any that aren't needed:

1. **Create** the database, as a copy of `main`'s for a new branch.
2. **Reset the schema** if the database can't be migrated forward: it has
   another branch's migrations, an applied migration was edited, or it's past
   the target version. A reset **deletes all tables and data** and re-applies
   every migration.
3. **Migrate**: apply pending migrations.
4. **Seed** the dataset, only if the database has no data. Existing data is
   kept, even if it isn't the declared dataset.

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

Seeders write the current schema, so an older `--schema-version` defaults to
`--data none`.

The datasets are:

- **`dev`**: what `pnpm dev` runs on. The golden rows plus the golden
  meetings' full transcripts and people. Voiceprints are placeholders.
- **`golden`**: only the hand-verified rows from
  `packages/fixtures/test-data/` (jurisdictions, bodies, video sources).

[`dbranch.config.ts`](../../dbranch.config.ts) at the repository root lists the
datasets `--data` can name and picks the default, so `@open-minutes/db` imports
no data itself. The CLI uses the nearest `dbranch.config.ts` at or above the
current directory (`DBRANCH_CONFIG` overrides that).

The seeders live in `packages/fixtures/src/seed/`. They assign fixed ids (so
URLs are stable), then advance the id sequences past them.

## The other commands

| Command            | What it does                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm db migrate`  | Applies pending migrations (up to `--schema-version`). Never resets or seeds; fails if the database can't be migrated forward. What deploys run.                                                 |
| `pnpm db wipe`     | Drops all tables, data and migration history.                                                                                                                                                    |
| `pnpm db status`   | Shows the schema version, the dataset and whether it's current, and any pending or unexpected migrations. `--check` exits non-zero if it needs migrating; `--json` prints the state for scripts. |
| `pnpm db generate` | Writes a new migration from your `schema.ts` changes.                                                                                                                                            |
| `pnpm db check`    | Checks the migrations for conflicts.                                                                                                                                                             |
| `pnpm db studio`   | Opens Drizzle Studio on the database.                                                                                                                                                            |
| `pnpm db prune`    | Lists databases of deleted branches, leftover test databases and outdated test templates. `--yes` drops them.                                                                                    |

`migrate`, `wipe`, `status`, `studio` and `up` all take `--db`.

## Remote databases

- `pnpm db up`, `pnpm dev` and `om` only check a remote database's schema, and
  fail if it's missing migrations.
- `pnpm db migrate` is the only command that changes one, and only moves
  forward.
- `pnpm db wipe` refuses unless `ALLOW_REMOTE_WIPE=1`.

`pnpm deploy:prod` migrates prod, then deploys the Worker, so new code never
runs on an old schema. Old code does briefly run on the new schema, so
migrations must be backward-compatible: add first, deploy, remove later.

## Neon branches

A workspace that needs production data (e.g. a remote agent session) can use
its own Neon branch, a copy-on-write fork of production, via
[`neonctl`](https://neon.tech/docs/reference/neon-cli). With `NEON_API_KEY`
(project-scoped) set:

```sh
npx neonctl branches create --project-id <id> --name dev/my-branch \
  --expires-at "$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)"
echo "DATABASE_URL_MYBRANCH=$(npx neonctl connection-string dev/my-branch --project-id <id>)" >> .env.local
DB=mybranch pnpm db migrate
```

`npx neonctl branches reset dev/my-branch --parent` re-forks it from
production without changing its URL. Mark the production branch protected in
Neon so none of this can touch it.

### PR previews

[`.github/workflows/pr-preview.yml`](../../.github/workflows/pr-preview.yml)
uses Neon's GitHub Actions to give each PR a Neon branch (`preview/pr-N`),
migrates it in deploy mode, and deploys a separate Worker, `open-minutes-pr-N`,
at `https://open-minutes-pr-N.<account>.workers.dev`, with the branch's pooled
URL uploaded as a secret in the same request (`wrangler deploy
--secrets-file`). It comments the URL on the PR and deletes both when the PR
closes.

The branch persists across pushes, so data reviewers enter survives. If a push
edits a migration the branch already has (`.diverged` in `pnpm db status --json`),
the workflow resets the branch from production before migrating.

It's opt-in: it needs the `NEON_API_KEY` and `CLOUDFLARE_API_TOKEN` secrets,
the `NEON_PROJECT_ID` and `CLOUDFLARE_ACCOUNT_ID` variables, and a registered
workers.dev subdomain. A Worker per PR was chosen over preview versions of the
production Worker: versions inherit production's secrets, can't be deleted,
and would need the database URL as a plaintext var.

Previews are public URLs serving a copy of production data. That's fine for
public meeting records; put Cloudflare Access in front if that changes. A
Worker whose cleanup fails leaks: unlike Neon branches, Workers have no TTL.

## Changing the schema

1. Edit [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts).
2. Run `pnpm db generate` and commit the migration it writes to
   `packages/db/src/migrations/`. CI fails if you forget.
3. Run `pnpm db up` (or restart `pnpm dev`) to apply it.

If the migration transforms existing data, test it in
[`packages/db/src/migration-tests/`](../../packages/db/src/migration-tests/):
start at the version before yours, insert rows shaped like production's,
migrate, and check the result:

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

Use raw SQL: drizzle's table objects only describe the latest schema.

Never edit a migration that's on `main`; add a new one. Editing an unmerged one
is fine: `pnpm db up` notices and resets your branch's database.

## Databases in tests

Each test that needs a database gets its own copy of a template database,
which takes tens of milliseconds:

```ts
import { dbTest } from "@open-minutes/db/testing/vitest";
import { goldenData } from "@open-minutes/fixtures/golden-data";

const test = dbTest({ data: goldenData });

test("…", async ({ testDb }) => {
  // testDb starts at the latest schema with the golden rows
});
```

`dbTest` takes the same `schemaVersion` and `data` as `pnpm db up`. Each
(schema version, dataset) pair gets a template, rebuilt only when the
migrations or dataset change. The pipeline's tests use `goldenTest`
(`dbTest({ data: goldenData })` plus helpers). The e2e test uses
`goldenMeetingsData(slugs)`, whose real voiceprints take minutes to compute;
pass `setupTimeoutMs` for slow datasets like that.

## How it works

### Why

Previously every branch shared one hand-managed local database. Migrating on a
feature branch and switching back left `main`'s code on a schema it didn't
know, and drizzle, which tracks migrations only by name, didn't notice.
Worktrees, agent sessions, PR previews and CI also each need their own database.

So every database, local or remote, dev or test, is brought to a **declared
state** by one function, `ensureDatabase` in
[`packages/db/src/ensure.ts`](../../packages/db/src/ensure.ts), and local
databases are per branch.

### Declared state

A declared state is a schema version plus an optional dataset. The harness
applies the committed migrations; it never diffs `schema.ts` against a live
database. Migrations are append-only, so a version names one schema forever.

A dataset has a name, a fingerprint, and a function that writes its rows. The
harness stores the applied fingerprint in the database, so `status` and
`--data-reset if-needed` can tell whether the data is current.

### Detecting drift

The harness compares drizzle's journal with the migration files on disk by
name **and** hash, so it can tell:

- **pending**: in this checkout, not yet applied;
- **unknown**: applied, but not in this checkout, e.g. another branch's;
- **modified**: applied, then edited.

Pending migrations are applied. Unknown or modified ones mean the history
diverged: `up` resets a local database, and anything else stops with an error.

A per-database advisory lock means concurrent starts migrate only once. Neon `-pooler` URLs are
switched to the direct host, since the pooler can leave advisory locks stuck.

### Per-branch databases

`local` resolves to `open_minutes__<branch>`, read from `.git/HEAD` (so it works
in worktrees). `main` and `master` share `open_minutes__main`. Mid-rebase uses
the branch being rebased. Any other detached HEAD gets
`open_minutes__detached_<commit>`, so old code can't reset `main`'s database.

A new branch's database is copied from `open_minutes__main`, or created empty
and seeded if `main`'s is in use. A pre-existing `open_minutes` database with
data is renamed to `open_minutes__main` on first use.

### Where it runs

- **`pnpm dev`** runs `pnpm db up`.
- **`pnpm web:dev`**: a Vite plugin
  ([`packages/web/vite/dev-database.ts`](../../packages/web/vite/dev-database.ts))
  migrates without seeding, then passes the URL to the Worker, which can't
  read `.env.local` or `.git` itself.
- **`om`**, before every command, so `DB=prod om ingest` fails fast if
  production is behind.
- **Tests** build their templates with it.
- **`pnpm deploy:prod`**.
- **CI** ([`.github/workflows/db.yml`](../../.github/workflows/db.yml)) checks
  for migration conflicts and ungenerated schema changes, runs `up` twice (the
  second must do nothing), wipes, rebuilds with `migrate`, and runs the
  database tests. With Neon configured, a second job applies the PR's
  migrations to a throwaway fork of production in deploy mode, catching
  migrations that fail on real rows (a `NOT NULL` over existing nulls, a unique
  index over duplicates) and PRs missing `main`'s migrations.

The deployed Worker doesn't check its schema at runtime, which would cost a
query per cold start; migrating before deploying covers it.
