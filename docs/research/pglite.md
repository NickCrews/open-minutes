# PGlite for tests and dev

Whether to replace docker-compose's Postgres with
[PGlite](https://pglite.dev) (Postgres compiled to WASM, running in-process)
for tests and local development. Findings are from 2026-10-19, with PGlite
0.5.10 and `@electric-sql/pglite-socket` 0.2.13, on a 4-core Linux container.
Re-test before relying on them.

**Decision: not now.** PGlite runs our schema, but the transition cost is
high. For tests it is a speedup only with rollback-per-test, which would also
speed up the current setup. For dev it adds a socket server and
one-process-per-database limits. The main gain is not needing docker.

## Compatibility

All migrations through `20261018193001_slugs` apply cleanly, including
pgvector's HNSW index on `people.voice_embedding` and the btree_gist exclusion
constraint on `chapters`. Extensions are loaded explicitly:

```ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector"; // separate package as of 0.5
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const pg = await PGlite.create({ extensions: { vector, btree_gist } });
```

Differences from our Postgres:

- PGlite 0.5.10 is Postgres 18.6, the same major version as docker-compose's
  `pgvector/pgvector:pg18` and Neon prod, but compiled to 32-bit WASM.
- One connection per instance. Advisory locks succeed but lock nothing, so
  `ensure.test.ts`'s "concurrent ensures of one database migrate it exactly
  once" can't be tested on it.
- One database per instance. There is no `CREATE DATABASE … TEMPLATE`, which
  `testing/index.ts` and per-branch databases rely on.
- Only one process can open a data directory.

## Speed

### Current tests (docker Postgres)

The 23 test files that use a database (110 tests, excluding
`golden-meetings-data.test.ts`, which needs `yt-dlp`) take **33 s** wall time
warm, 36 s cold, on 4 workers. The median test takes 485 ms; the p90 takes
656 ms.

The fixture alone (`createTestDb` from an existing template, one query,
`drop`):

| Template | Serial, create | Serial, drop | 4 workers concurrently, per test |
| -------- | -------------- | ------------ | -------------------------------- |
| empty    | 237 ms         | 40 ms        | ~550 ms                          |
| golden   | 102 ms         | 41 ms        | ~540 ms                          |

So the fixture costs ~550 ms per test under the suite's concurrency: about
15 s of the 33 s.

### PGlite

Template: all migrations, no data, saved with `dumpDataDir("none")` (42 MB).

| Operation                                           | 1 process | 4 processes  |
| --------------------------------------------------- | --------- | ------------ |
| First instance in a fresh process, from the dump    | ~1.0 s    | ~3.5 s       |
| New instance per test from the dump (`loadDataDir`) | 1.0 s     | 1.3–1.6 s    |
| `clone()` of a warm instance                        | 1.3 s     | 1.4–1.5 s    |
| `BEGIN` … `ROLLBACK` on a shared instance           | ~2 ms     | 2–7 ms       |
| Process memory                                      | ~770 MB   | ~800 MB each |

Starting from `initdb` instead of a dump takes 3–5 s. Running all migrations
takes ~0.3 s.

Query speed is close to native:

|                          | PGlite | docker Postgres |
| ------------------------ | ------ | --------------- |
| 2,000 single-row inserts | 1.1 s  | 2.5 s           |
| 2,000 point selects      | 1.1 s  | 0.8 s           |
| Aggregate over 400k rows | 62 ms  | 27 ms           |

### Projected suite time

Estimated from the numbers above, not measured:

| Design                                            | Fixture overhead | Suite    |
| ------------------------------------------------- | ---------------- | -------- |
| Docker, template clone per test (today)           | ~15 s            | 33 s     |
| PGlite, fresh instance per test                   | ~55–60 s         | ~75 s    |
| PGlite, instance per test file, rollback per test | ~20 s            | ~35–40 s |
| PGlite, instance per worker, rollback per test    | ~4 s             | ~20–25 s |

The last row needs `isolate: false` for the database packages, so an instance
outlives a test file. Four workers then hold ~3.2 GB.

Rollback-per-test has its own costs, on either backend:

- Code under test that calls `db.transaction()` needs care. (The calls in
  the `golden` and `dev` seeders run only when a template is built.)
  drizzle turns `tx.transaction()` into a savepoint, so it works if the test
  passes its outer `tx` in as `db`. That `tx` isn't typed as `DB`, though. On
  postgres.js, `db.transaction()` on a pooled `db` takes a different
  connection, which can't see the test's uncommitted rows.
- Migration tests start at older schema versions and run `migrateTo`, so they
  still need a database of their own.

## Dev

- Per-branch data directories (`.data/pglite/<branch>/`) would replace
  per-branch databases; a new branch copies main's directory.
- The web app runs in workerd and connects over TCP with a postgres.js client
  per request, so `pnpm web:dev` would need `pglite-socket` serving the data
  directory. It multiplexes clients over PGlite's single connection; its
  README warns "not all use cases are guaranteed to work". Transactions from
  different clients would interleave.
- While the dev server holds the data directory, `om`, `pnpm db studio` and
  `pnpm db status` would have to connect through the socket rather than open
  it.

## What a switch would touch

- `cluster.ts`: docker startup, `withAdmin`, `pg_database` queries; mostly
  deleted.
- `testing/index.ts`: templates become dumped data directories cached on disk
  by fingerprint.
- `ensure.ts` and `TestDb`: identified by URL throughout; would need to accept
  a PGlite handle too.
- `getDb()`: `drizzle-orm/pglite` for local targets.
- All nine migration-test files use `testDb.client` as a postgres.js tagged
  template.
- `pnpm db prune` and the legacy `open_minutes` rename.

## Method

Benchmarks were throwaway scripts: PGlite in a scratch npm project applying
each `migration.sql` split on `--> statement-breakpoint`, and `createTestDb`
from `@open-minutes/db/testing` run under `tsx` against docker-compose's
Postgres, then `pgvector/pgvector:pg17`. Suite timings are `vitest run` over the files matching
`dbTest|goldenTest|createTestDb|testing/vitest`, with the JSON reporter for
per-test durations.
