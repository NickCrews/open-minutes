# @open-minutes/datasets

Named sets of [test-data](../fixtures/README.md) rows to seed a database with.
Each dataset is a JSON spec in [`specs/`](specs/) naming which rows it holds;
this package seeds a database with one. `pnpm db up` and the per-test database
helpers both take a dataset; see
[docs/contributing/db.md](../../docs/contributing/db.md).
