# ADR 0003: Declarative database harness, per-branch databases

Date: 2026-09-27
Status: Proposed

## Context

Before this change, the database was brought up to date by hand: `pnpm db:migrate`
(`drizzle-kit migrate`) against whatever `DB` pointed at. That caused problems:

- **Branches shared one local database.** Migrating on a feature branch and then
  checking out `main` left `main`'s code on a schema it doesn't know about.
  drizzle records applied migrations by name, so it never noticed; it failed later,
  e.g. trying to re-`CREATE` an existing enum. `pnpm db:nuke` existed to recover.
- **Nothing ensured the schema at startup.** `pnpm dev` started the app on
  whatever schema the database had.
- **Tests had a harness; dev and prod didn't.** Tests already cloned a migrated
  template database per test. Nothing else could say "this database should be in
  state X".
- **Parallel workspaces.** Worktrees, remote agent sessions, and CI each need
  their own database that doesn't disturb the others.

## Decision

### One harness: `ensureDatabase(url, { data })`

`db/src/ensure.ts` makes the database at a URL match a declared state. The
state has two parts:

- **Schema:** a _schema version_ (default `"latest"`). `schema.ts` is still the
  source of truth. `drizzle-kit generate` turns it into reviewed, versioned SQL,
  and the harness applies that SQL. This is the industry-standard split (Prisma,
  Atlas versioned, Rails): author the schema declaratively, apply it as versioned
  migrations, and never diff-and-apply straight to a real database.
- **Data (optional):** a `DataState` `{ name, fingerprint, apply }`. The harness
  records the fingerprint it applied in `drizzle.__om_data_state` and re-applies
  only when the fingerprint changes. See [Datasets](#datasets).

It compares the drizzle journal against the migrations on disk by name **and**
hash, so it sees three conditions: _pending_, _unknown_ (applied but not in this
checkout, e.g. another branch's), and _modified_ (edited after being applied).
It takes a per-database `pg_advisory_lock`, so concurrent starts (two dev
servers, parallel CI) migrate once.

Getting to the declared state by the least destructive path is always
allowed: creating a missing local database (cloned from main's) and applying
pending migrations. Two steps can destroy data, and each takes a reset policy,
`never`, `if-needed` or `always`:

|               | `if-needed` means                                                                                                                                                            | `always` means                          | Default                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `schemaReset` | Wipe the schema and re-apply every migration when forward isn't possible: the history diverged (another branch's or an edited migration), or the database is past the target | Wipe it every time, starting from empty | `if-needed` for local databases, else `never`  |
| `dataReset`   | Apply the declared data over data that isn't it                                                                                                                              | Apply it every time, undoing hand edits | `never`: seed only a database that has no data |

The options take a policy rather than a boolean because the defaults depend on
the target, and because `always` is a real third case. With `schemaReset:
"never"`, divergence is an error naming the fix, and nothing is touched. A
non-local database never gets a schema reset or any declared data unless
`ALLOW_REMOTE_WIPE=1` says it's disposable, so against production the harness
can only migrate forward.

### The CLI: up, migrate, wipe

`pnpm db` has one declarative command and imperative ones that each do one
thing:

- **`migrate`** moves forward: it applies pending migrations, up to
  `--schema-version`, with `schemaReset: "never"` and no data. It never wipes,
  resets or seeds.
- **`wipe`** moves back to empty (`wipeDatabase`): it drops the tables, the
  migration journal and the data record, leaving what a new database has.
- **`up`** is declarative (`prepareDatabase`): it brings a database to
  `--schema-version` (default latest) plus `--data` (default `dev`) by the least
  destructive path, and is a no-op when it's already there. Its flags are the
  two policies, `--schema-reset` and `--data-reset`. It's what `pnpm dev`
  runs. On a remote database it only verifies the schema, whatever the flags.

So `up` migrates forward when it can, and wipes only when it has to.
`up --schema-reset always` starts over completely.

`status`, `prune`, `generate`, `check` and `studio` only read or manage
databases.

### Schema versions

A schema version names a point in the migration history: `"latest"`, or one
migration by its full folder name (`20260719061307_split-munis-into-jurisdictions-and-bodies`),
its timestamp (`20260719061307`), or its tag (`split-munis-into-jurisdictions-and-bodies`).
The schema _at_ a version is every migration up to and including it. Migrations
are append-only, so a version names the same schema forever. `ensureDatabase`,
`createTestDb`/`dbTest`, `pnpm db up` and `pnpm db migrate` all take one, and
`pnpm db status` reports the version a database is at. Migrations only go
forward: asking a database for an older version than it has is an error with
`schemaReset: "never"` (`migrate`), and a schema reset otherwise (`up` on a
local database).

### Migration tests

A migration that moves data (not just DDL) gets a vitest test in
`db/src/migration-tests/`:

```ts
const test = dbTest({
  schemaVersion: "panoramic_dagger", // the version just before
  data: sqlData("legacy", `INSERT INTO municipalities ...`), // prod-shaped rows
});

test("splits municipalities", async ({ testDb }) => {
  // ...assert on the "before" data...
  await testDb.migrateTo("split-munis-into-jurisdictions-and-bodies");
  // ...assert the data was translated correctly...
});
```

The seed and assertions use raw SQL (`sqlData`, `testDb.client`), because
drizzle's table objects describe only the latest schema. `migrateTo` applies
migrations the way deploys do (forward only, `schemaReset: "never"`). Pinning both ends to named versions
keeps the test valid forever as later migrations accumulate. Every migration
that transforms existing data has one (`db/src/migration-tests/`); pure DDL
needs none beyond applying cleanly. CI runs these with the other DB tests.

### Per-git-branch local databases

With no configuration, `"local"` now resolves to `open_minutes__<branch>` on
docker-compose's postgres, `main` and `master` included (they share
`open_minutes__main`). The
branch comes from reading `.git/HEAD`, which works in worktrees. Mid-rebase,
HEAD is detached, so the branch comes from git's rebase state instead. Any
other detached HEAD (`git bisect`, an old commit, a tag) gets
`open_minutes__detached_<commit>`: old code would otherwise see main's newer
migrations as divergence and reset main's database. A branch's database is created on first use as a `TEMPLATE` clone of
`open_minutes__main`, so it starts with the data you already had. If `main`'s database
is busy, it's created empty and seeded instead. `pnpm db prune` drops databases
whose branch is gone, test databases left by interrupted runs, and test
templates for anything but the latest schema and the configured datasets;
`main`'s database is pruned like any other once its branch is gone. Plain
`open_minutes` is left to docker-compose as its empty default database; a
database `main` used there before this naming is renamed into place on first
use. To use one database on every branch, point `DB`
at its URL.

### Datasets

Datasets are `DataState`s. `golden` and `dev` live with the data they load, in
`@open-minutes/fixtures` (`fixtures/src/seed/`); `goldenMeetingsData` lives in
`pipeline/src/seed/`, because computing voiceprints needs the pipeline's
embedding model. `@open-minutes/db` knows none of them. It owns the `pnpm db`
CLI, which reads the datasets `--data` can name from a `dbranch.config.ts` at
the repository root, the way drizzle-kit and vitest read their configs:

```ts
export default defineConfig({
  datasets: { dev: devData, golden: goldenData },
  defaultDataset: "dev", // what `pnpm db up` seeds into an empty database
});
```

The CLI finds the nearest config at or above the directory it was run from
(`DBRANCH_CONFIG` overrides that), and imports it only for the commands that
use datasets (`up`, `status`, `prune`). The config is the only place that ties
the harness to the data. Nothing depends on the repository root, so it can
import from any package without adding a dependency edge, and dependencies run
pipeline → fixtures → db → core, never back:

- **`golden`** (`golden-data.ts`): the hand-verified rows from `test-data/`
  (jurisdictions, bodies, video sources). It's for evals, benchmarks and tests,
  and stays small and exact.
- **`dev`** (`dev-data.ts`): what the playground runs on. It's `golden` plus the
  golden meetings' full transcripts, speakers and people, plus extra fixtures in
  `dev-data/`, in the same format (`transcript.psv` instead of `golden.psv`,
  since they aren't verified). The extras are clearly fictional ("Demo County"),
  so dev data never puts invented words or bios on real people. Voiceprints are
  deterministic placeholders: seeding real ones would mean downloading and
  embedding hundreds of MB of audio per meeting.

- **`goldenMeetingsData(slugs)`** (`golden-meetings-data.ts`): `golden` plus
  the given golden meetings seeded as history, with _real_ voiceprints computed
  from their audio. The e2e recognition test starts from it. Computing
  voiceprints is slow, and as a dataset it runs once per change to its inputs
  (fixtures, embedding model); later runs clone the cached template.

Tests pick one with `dbTest({ data })` (e.g. the pipeline's `goldenTest`
fixture), layer scenario rows on top in the test body, or compose their own
`DataState`. Every distinct (schema version, dataset) gets its own cached
template. Seeders assign ids explicitly, so the same fixture always gets the same
ids (and URLs), and then advance the id sequences past them so the app's own
inserts don't collide.

### Where the harness runs

Every entrypoint that uses a database, rather than building one, starts with
`prepareDatabase(url)`, so they all agree on what "ready" means. On local
targets it ensures the schema. On remote targets it only **verifies**: nothing
but a deploy mutates a real database.

- **`pnpm dev`** runs `pnpm db up` first, which is `prepareDatabase` with the
  `dev` dataset. The data is seeded only into a database that is empty: new,
  reset, or migrated with no rows and no recorded data (`dataReset: "never"`). So data
  you've built up locally is never overwritten, and the order you start things
  in doesn't matter.
- **Vite dev server start** (`web/vite/dev-database.ts`) runs it for
  `pnpm web:dev`, then passes the resolved URL into the Worker's `vars`. workerd
  can't read `.env.local` or `.git`, so it can't resolve the target itself.
- **The `om` CLI** runs it before every command, so `om ingest` on a new
  branch just works, and `DB=prod om ingest` fails fast if prod is behind.
- **Tests:** templates are built by the same harness and keyed by
  `hash(migrations) + hash(data)`. `dbTest({ data: goldenData })` gives each test
  a clone of a pre-seeded database in tens of milliseconds.
- **Deploy:** `pnpm run deploy` runs `pnpm db migrate --db prod` _before_
  `wrangler deploy`. Code therefore never runs against a schema it's ahead of.
  Old code briefly runs against the new schema, so migrations must be
  backward-compatible (expand, deploy, then contract in a later change).
- **CI** (`.github/workflows/db.yml`) starts Postgres the way a developer does
  (the harness runs `docker compose up`). It checks that migrations don't
  conflict (`drizzle-kit check`), that `schema.ts` has no ungenerated changes,
  that a fresh database reaches the declared state (with a second `up` as a
  no-op), and that `migrate` builds a wiped database forward to current. It also runs the
  DB-backed and migration tests.
- **Remote agent sessions** each run in their own container, so they use the
  local docker-compose postgres: fully isolated, free, and seeded with `dev`.

## Consequences

- Switching git branches no longer corrupts anything: each branch has its own
  local database, and divergence is detected and repaired.
- `migrate`'s refusals stop `pnpm run deploy` before `wrangler deploy` when
  production's history has diverged from the code being deployed (e.g. a branch
  missing main's migrations), instead of corrupting production.
- Editing an already-applied migration is detected (as "modified") instead of
  silently ignored. In dev this resets the schema; against a real database it is an error.
- Each branch database costs a little disk; `pnpm db prune` reclaims it.
- The deployed Worker doesn't check its schema at runtime: `db()` is
  synchronous, and a per-isolate check would add a query to cold starts. The
  deploy ordering (migrate, then deploy) plus the `status --check` gate cover it
  instead.
