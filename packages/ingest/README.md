# @open-minutes/ingest

The offline processing pipeline that turns raw meeting audio into speaker-attributed transcripts in the database. It transcribes audio locally with `@open-minutes/audio` (sherpa-onnx, downloading ONNX models on demand), cleans disfluencies such as "um" and stutters out of the transcript (see `@open-minutes/core/transcription`'s `clean.ts`), diarizes it into anonymous speaker turns with per-speaker voiceprint embeddings (also `@open-minutes/audio`), aligns those turns with the transcript at the word level, and then recognizes speakers by matching their voiceprints against the people already in the database (by cosine similarity) before inserting the resulting segments. Everything runs in-process with no external services or GPUs required.

## The `om` CLI

The `om` CLI, in `@open-minutes/agents`, has three composable commands over
this package. Run it as `pnpm om <command>` from anywhere in the repository. Machine-readable results
go to stdout and all human progress/logs go to stderr, so results can be piped:

```sh
pnpm om status           # list ingested meetings (--json for JSON-lines, ids to filter)
pnpm om available        # meetings on bodies' meeting sources not yet ingested (--body <slug> to filter)
pnpm om ingest [refs...] # run the full pipeline per meeting (reads stdin if no args)

pnpm -s om available | head -5 | pnpm -s om ingest   # ingest the 5 newest available meetings
```

When piping, pass `-s` so pnpm doesn't echo the script to stdout.

Each body has at most one **meeting source** (`bodies.meeting_source`): a
YouTube channel or playlist, or an Alaska Legislature committee on akleg.gov.
`om available` scans each one and prints a line per new meeting,
`<id>\t<body slug>`, each body's newest first. The ID is a YouTube video ID or
an akleg.gov meeting ID (`HRES 2018-09-10 14:00:00`, spaces and all), and the
meeting goes in `meetings.site_kind` and `meetings.site_id`. `om ingest` reads
those lines, or takes YouTube or akleg.gov IDs or URLs as arguments. Given no
body, it uses the one whose meeting source is the meeting's YouTube channel or
akleg.gov committee; a meeting from a playlist needs its body named with
`--body <slug>`, since a video doesn't say which playlists it's on.

That body is one of the meeting's bodies (in `meeting_bodies`), and its
timezone becomes the meeting's. A joint meeting, held by several bodies
together, is published by one of them, and its title names the rest: for
"Girdwood Board of Supervisors and Girdwood Land Use Committee Joint Meeting",
found through GBOS's channel, both GBOS and the Land Use Committee are recorded.
Only a title that says "joint" is read this way, and only bodies in the found
body's jurisdiction, named in full or by short name, are matched. Fix a wrong
guess with `pnpm om tools set_meeting_bodies
'{"meeting":12,"bodies":["gbos","luc"]}'`.

To scan a new body, set its source, eg:

```sql
UPDATE bodies SET meeting_source = '{"type":"akleg_committee","committee":"HRES"}' WHERE id = 5;
-- or {"type":"youtube_channel","channel_id":"UC..."}
-- or {"type":"youtube_playlist","playlist_id":"PL..."}
```

Commands default to the `local` database; target any named database with
`DB=<name> pnpm om <cmd>` (eg `DB=prod`). Ingestion is all-or-nothing per meeting:
the meeting row and its segments are committed in one transaction only after
every stage succeeds. Each stage's artifact (audio, transcription JSON,
diarization JSON) is cached in a gitignored per-meeting work directory under
`data/meetings/<body-slug>_<id>/` (an akleg.gov ID's spaces and colons become
`-`), so an interrupted run resumes from
the last completed stage; to fully reprocess a meeting, delete its DB row and
its work directory. The CLI is a thin wrapper over the exported API
(`listIngested`, `listAvailable`, `ingestMeeting` from
`@open-minutes/ingest/om`), so scripts and tests reuse the same logic.

## Meeting audio cache

`@open-minutes/ingest/audio-cache` downloads a meeting's audio into the
per-machine cache (`~/.cache/open-minutes/meetings/<youtubeId>/`) and reads it
back. The audio tools in `@open-minutes/agents` use it to open a meeting; they
call the models in `@open-minutes/audio` directly.
