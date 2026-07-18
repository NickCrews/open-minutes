# @open-minutes/pipeline

The offline processing pipeline that turns raw meeting audio into speaker-attributed transcripts in the database. It transcribes audio locally with sherpa-onnx (downloading ONNX models on demand), diarizes it into anonymous speaker turns with per-speaker voiceprint embeddings, aligns those turns with the transcript at the word level, and then matches voiceprints against known people (by cosine similarity against embeddings stored in the database) before inserting the resulting segments. Everything runs in-process with no external services or GPUs required.

## The `om` CLI

The pipeline ships an `om` bin (run `pnpm om ...` here or at the repo root)
with three composable commands. Machine-readable results go to stdout and all
human progress/logs go to stderr, so results can be piped:

```sh
om status              # list ingested meetings (--json for JSON-lines, ids to filter)
om available           # video IDs on muni channels not yet ingested, newest first (--muni <slug> to filter)
om ingest [ids...]     # run the full pipeline per video (reads stdin if no args)

om available | head -5 | om ingest   # ingest the 5 newest available meetings
```

Commands default to the `local` database; target any named database with
`DB=<name> om <cmd>` (eg `DB=prod`). Ingestion is all-or-nothing per meeting:
the meeting row and its segments are committed in one transaction only after
every stage succeeds. Each stage's artifact (audio, transcription JSON,
diarization JSON) is cached in a gitignored per-meeting work directory under
`data/meetings/<muni-slug>_<youtubeId>/`, so an interrupted run resumes from
the last completed stage; to fully reprocess a meeting, delete its DB row and
its work directory. The CLI is a thin wrapper over the exported API
(`listIngested`, `listAvailable`, `ingestVideo` from
`@open-minutes/pipeline/om`), so scripts and tests reuse the same logic.
