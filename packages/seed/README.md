# @open-minutes/seed

Seeds a database with one of the [datasets](../datasets/README.md) declared in
`packages/datasets/datasets/`. `datasetState(name)` returns it in the form
`@open-minutes/db`'s harness takes, so `pnpm db up --data <name>` and `dbTest`
seed the same rows. Real voiceprints are computed from the meetings' audio with
`@open-minutes/audio`, which is why seeding lives here and not in
`@open-minutes/datasets`: `audio`'s tests read the datums, so
`@open-minutes/datasets` can't depend on `audio`. See
[docs/contributing/db.md](../../docs/contributing/db.md).
