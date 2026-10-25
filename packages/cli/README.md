# @open-minutes/cli

The `om` CLI, for development: ingest meetings into your database by hand and
download the ML models. Run it as `pnpm om <command>` from anywhere in the
repository.

```sh
pnpm om status          # meetings already ingested (--json for JSON lines)
pnpm om available       # meetings on bodies' meeting sources not yet ingested
pnpm om ingest <id>     # run the full pipeline for a meeting (reads stdin if no args)
pnpm om models          # download every ML model up front (~650MB)
```

It is a thin client: each command parses its arguments, calls
`@open-minutes/ingest/om` or `@open-minutes/audio/models`, and prints the
result. Put new logic in those packages and call it from here. See the
[ingest README](../ingest/README.md) for what the ingestion commands do.

Commands use your branch's local database; `DB=<name> pnpm om <cmd>` picks
another.
