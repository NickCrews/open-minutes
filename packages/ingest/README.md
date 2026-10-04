# @open-minutes/ingest

The offline processing pipeline that turns raw meeting audio into speaker-attributed transcripts in the database. It transcribes audio locally with `@open-minutes/audio` (sherpa-onnx, downloading ONNX models on demand), cleans disfluencies such as "um" and stutters out of the transcript (see `@open-minutes/core/transcription`'s `clean.ts`), diarizes it into anonymous speaker turns with per-speaker voiceprint embeddings (also `@open-minutes/audio`), aligns those turns with the transcript at the word level, and then recognizes speakers by matching their voiceprints against the people already in the database (by cosine similarity) before inserting the resulting segments. Everything runs in-process with no external services or GPUs required.

## The `om` CLI

The `om` CLI, in `@open-minutes/agents`, has three composable commands over
this package. Run it as `pnpm om <command>` from anywhere in the repository. Machine-readable results
go to stdout and all human progress/logs go to stderr, so results can be piped:

```sh
pnpm om status          # list ingested meetings (--json for JSON-lines, ids to filter)
pnpm om available       # video IDs on bodies' video sources not yet ingested, newest first (--body <slug> to filter)
pnpm om ingest [ids...] # run the full pipeline per video (reads stdin if no args)

pnpm -s om available | head -5 | pnpm -s om ingest   # ingest the 5 newest available meetings
```

When piping, pass `-s` so pnpm doesn't echo the script to stdout.

Commands default to the `local` database; target any named database with
`DB=<name> pnpm om <cmd>` (eg `DB=prod`). Ingestion is all-or-nothing per meeting:
the meeting row and its segments are committed in one transaction only after
every stage succeeds. Each stage's artifact (audio, transcription JSON,
diarization JSON) is cached in a gitignored per-meeting work directory under
`data/meetings/<body-slug>_<youtubeId>/`, so an interrupted run resumes from
the last completed stage; to fully reprocess a meeting, delete its DB row and
its work directory. The CLI is a thin wrapper over the exported API
(`listIngested`, `listAvailable`, `ingestVideo` from
`@open-minutes/ingest/om`), so scripts and tests reuse the same logic.

## Meeting audio cache

`@open-minutes/ingest/audio-cache` downloads a meeting's audio into the
per-machine cache (`~/.cache/open-minutes/meetings/<youtubeId>/`) and reads it
back. The audio tools in `@open-minutes/agents` use it to open a meeting; they
call the models in `@open-minutes/audio` directly.
