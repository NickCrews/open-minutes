# @open-minutes/pipeline

The offline processing pipeline that turns raw meeting audio into speaker-attributed transcripts in the database. It transcribes audio locally with sherpa-onnx (downloading ONNX models on demand), cleans disfluencies such as "um" and stutters out of the transcript (see `@open-minutes/core/transcription`'s `clean.ts`), diarizes it into anonymous speaker turns with per-speaker voiceprint embeddings, aligns those turns with the transcript at the word level, and then recognizes speakers by matching their voiceprints against the people already in the database (by cosine similarity) before inserting the resulting segments. Everything runs in-process with no external services or GPUs required.

## The `om` CLI

The pipeline ships an `om` CLI with three composable commands. Run it as
`pnpm om <command>` from anywhere in the repository. Machine-readable results
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
`@open-minutes/pipeline/om`), so scripts and tests reuse the same logic.

## Audio tools for transcript cleanup

Diarization and recognition make mistakes that the transcript's text alone
can't reveal: two people folded under one label, or speech the recognizer
skipped. `pnpm audio` gives an agent (or a person) tools that look at the
meeting's audio itself. It works like `pnpm tools`: JSON in, JSON out.

```sh
pnpm audio                                   # list the tools and golden meetings
pnpm audio <tool> --schema                   # a tool's input, as JSON Schema
pnpm audio find_untranscribed_speech '{"meeting":"gbos_9HoIM5INxpI"}'
pnpm audio transcribe_range '{"meeting":"gbos_9HoIM5INxpI","from":"0:01:56","to":"0:02:07"}'
```

A meeting is a golden fixture name or a database meeting id (`--db` picks the
database, as for `pnpm tools`). Its audio is downloaded into the per-machine
cache (`~/.cache/open-minutes/meetings/<youtubeId>/`) on first use, and what's
slow to compute (speech runs, voiceprints) is cached there too. Times are
`H:MM:SS.ss` like golden PSV files, so they go straight into a psvtool op.

- `speech_activity`: speech runs and pauses in a stretch, from voice activity
  detection.
- `find_untranscribed_speech`: stretches with speech but no transcript words,
  each with what recognition hears when it decodes just that stretch.
- `transcribe_range`: recognize one short stretch on its own, next to what the
  transcript has there.
- `voice_timeline`: who it sounds like, moment to moment, next to the
  transcript's labels, and where the voice changes.
- `match_voice`: whose voice a stretch or segment sounds like, ranked over the
  meeting's speaker labels.
- `audit_speaker`: whether one label is really one voice, and which of its
  segments sound like someone else.
- `compare_speakers`: label pairs that sound alike (an anonymous speaker
  number that's really a named person).

The voice tools compare CAM++ voiceprints, the model diarization uses, of 2 s
windows every 0.5 s (computed per minute of audio on first use, about a second
each, and cached). Each speaker label's voiceprint is sampled from its own
segments. On the golden meetings, one person's voiceprints score about 0.75 or
more against each other and different people under 0.5.

The tools are in `src/listen/`, typed like `@open-minutes/tools`' (a zod input
schema and a description for the model), exported as `listenTools`.
