# @open-minutes/pipeline

The offline processing pipeline that turns raw meeting audio into speaker-attributed transcripts in the database. It transcribes audio locally with sherpa-onnx (downloading ONNX models on demand), cleans disfluencies such as "um" and stutters out of the transcript (see `@open-minutes/core/transcription`'s `clean.ts`), diarizes it into anonymous speaker turns with per-speaker voiceprint embeddings, aligns those turns with the transcript at the word level, and then recognizes speakers by matching their voiceprints against the people already in the database (by cosine similarity) before inserting the resulting segments. Everything runs in-process with no external services or GPUs required.

## The `om` CLI

The pipeline ships an `om` CLI of composable commands. Run it as
`pnpm om <command>` from anywhere in the repository. Machine-readable results
go to stdout and all human progress/logs go to stderr, so results can be piped:

```sh
pnpm om status           # meetings and where each processing step stands (--json, ids to filter)
pnpm om available        # video IDs on bodies' video sources not yet meetings, newest first (--body <slug>)
pnpm om discover         # record those as meetings waiting to be processed; prints their IDs
pnpm om pending          # IDs of meetings with a step due, newest first (--limit, --stale, --json)
pnpm om process [ids...] # run each due step per meeting (reads stdin if no args; --stale to redo)
pnpm om ingest [ids...]  # record each video as a meeting if needed, then process it

pnpm -s om pending --limit 5 | pnpm -s om process   # process the 5 newest pending meetings
```

When piping, pass `-s` so pnpm doesn't echo the script to stdout.

Commands default to the `local` database; target any named database with
`DB=<name> pnpm om <cmd>` (eg `DB=prod`).

A meeting is recorded when it's discovered and processed later, one
**processing step** at a time (today just `transcript`; see
[ADR 0005](../../adrs/0005-discover-then-process-meetings.md)). Every attempt
at a step is a row in `processing_runs`, with the step's version, status,
error, and what it was made with, and a step's output commits in the same
transaction as its run's success, so a failed run writes nothing. A step's
state (pending, running, failed, done, stale) is derived from those runs; a
step that has failed 3 times at the current version is left out of `om
pending` but retried by `om process <id>`. Stale steps (made by an older
version, eg before `TRANSCRIPT_VERSION` was bumped) are only redone with
`--stale`.

Each stage's artifact (audio, transcription JSON, diarization JSON) is cached
in a gitignored per-meeting work directory under
`data/meetings/<body-slug>_<youtubeId>/`, so an interrupted run resumes from
the last completed stage. The CLI is a thin wrapper over the exported API
(`listMeetings`, `listAvailable`, `discoverMeetings`, `listPending`,
`processMeeting`, `ingestVideo` from `@open-minutes/pipeline/om`), so scripts
and tests reuse the same logic.

In production, `.github/workflows/discover-meetings.yml` runs `om discover`
and `om pending` twice a day and starts a `process-meeting.yml` run per
pending meeting.
