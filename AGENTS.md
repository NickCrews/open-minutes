# Open Minutes

pnpm monorepo: `packages/core` (DB schema and shared types), `packages/pipeline`
(ingestion: transcribe, diarize, align, recognize), `packages/web` (reader UI).
Architecture decisions live in `adrs/`.

## Terminology

Use the domain vocabulary defined in [`TERMINOLOGY.md`](TERMINOLOGY.md)
in code, comments, docs, UI copy, commits, and issues. In particular: a
**jurisdiction** contains **bodies**, and bodies hold **meetings**; a **speaker**
is per-meeting while a **person** is global; a **segment** is a run of words by
one speaker. Avoid the listed aliases (eg "muni", "utterance"). If you introduce
or change a domain concept, update `TERMINOLOGY.md` in the same change.

## Checks

Run `pnpm check` (typecheck, format check, lint, tests) before committing, and
`pnpm format` on files you change.
