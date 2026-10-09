# @open-minutes/agents

Every tool an agent uses, in one list with one API: the pipeline's steps,
which add a meeting and transcribe it; reading the transcript, fixing who
said what, naming people, replacing chapters; and listening to the audio. Add
new agent-facing tools here (summaries, say) rather than in a CLI of their
own.

Each tool is a name, a description written for the model, a zod input schema
(exported as JSON Schema), and `run(ctx, input)`. The context
(`toolContext(...)`) opens the database and a meeting's audio only when a tool
first needs them.

Every tool that takes a meeting in the database takes `"meeting"`: its slug
(eg `"gbos-2026-03-23"`, set on the golden fixture meetings, the same in every
database) or its id in this database (eg `12`). `list_meetings` shows both.
The tools read only the database, never the fixture files, so they work the
same wherever the database is: locally, in tests, or in production.

```sh
pnpm om tools                                # list the tools
pnpm om tools <tool> --schema                # a tool's input, as JSON Schema
pnpm om tools --describe                     # every tool with its schema, as JSON
pnpm om tools list_meetings
pnpm om tools find_untranscribed_speech '{"meeting":"gbos-2026-03-23"}'
pnpm om tools transcribe_range '{"meeting":"gbos-2026-03-23","from":"0:01:56","to":"0:02:07"}'
```

From TypeScript:

```ts
import {
  callTool,
  toAgentTool,
  toolContext,
  tools,
} from "@open-minutes/agents";

const ctx = toolContext(db); // or toolContext(async () => openDb())
const agentTools = tools.map((t) => toAgentTool(t, ctx));
```

## Pipeline step tools

One tool per step of
[`@open-minutes/pipeline`](../pipeline/README.md), in `src/pipeline/`. A
meeting goes from its site to a saved transcript in this order, each step
reading what the ones before it left in the meeting's work directory:

1. `discover_meetings`: meetings on bodies' meeting sources not in the
   database yet.
2. `add_meeting`: add one, by its ID on its site and the bodies that held it,
   untranscribed. Its date and time are read from its title.
3. `download_audio`
4. `transcribe`, then `clean_transcription`
5. `diarize` (any time after `download_audio`)
6. `align_speakers`, `embed_speakers`, `recognize_speakers`
7. `save_transcript`: write the segments and mark the meeting transcribed,
   which shows it to readers.
8. `find_date_in_transcript`: the date and time the chair states at the top,
   to check against the title's with `update_meeting`.

Nothing runs the next step for you. A step whose input is missing refuses,
naming the step to run first. `toolContext(db, { sites, workRoot })` takes
fake sites and a work root, for tests.

## Audio tools

Diarization and recognition make mistakes the transcript's text can't show:
two people folded under one label, or speech the recognizer skipped. The
tools in `src/audio/` look at the audio itself, for any meeting with a YouTube
video. Its audio is downloaded into the per-machine
cache (`~/.cache/open-minutes/meetings/<youtubeId>/`) on first use, and speech
runs, which are slow to compute, are cached there too. Times are `H:MM:SS.ss`
like golden PSV files, so they go straight into a psvtool op. The tools call
the models in `@open-minutes/audio` directly, and get a meeting's audio from
`@open-minutes/pipeline/audio-cache`.

- `speech_activity`: speech runs and pauses in a stretch, from voice activity
  detection.
- `find_untranscribed_speech`: stretches with speech but no transcript words,
  each with what recognition hears when it decodes just that stretch.
- `transcribe_range`: recognize one short stretch on its own, next to what the
  transcript has there.

`src/audio/audio.test.ts` runs them on a checked-in minute of real meeting
audio (`src/audio/testdata/`), and `src/audio/audio.bench.ts` times the
models on it. Because the clip is one minute long, `pnpm bench` reports each
model's time per minute of audio, so a model swap shows what it costs.
