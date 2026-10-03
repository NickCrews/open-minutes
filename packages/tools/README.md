# @open-minutes/tools

Every tool an agent uses to clean up a meeting, in one list with one API:
reading the transcript, fixing who said what, naming people, replacing
chapters, and listening to the audio. Add new agent-facing tools here
(summaries, say) rather than in a CLI of their own.

Each tool is a name, a description written for the model, a zod input schema
(exported as JSON Schema), and `run(ctx, input)`. The context
(`toolContext(...)`) opens the database and a meeting's audio only when a tool
first needs them, so the audio tools on a golden fixture work without
Postgres.

```sh
pnpm tools                                   # list the tools and golden meetings
pnpm tools <tool> --schema                   # a tool's input, as JSON Schema
pnpm tools --describe                        # every tool with its schema, as JSON
pnpm tools list_meetings
pnpm tools find_untranscribed_speech '{"meeting":"gbos_9HoIM5INxpI"}'
pnpm tools transcribe_range '{"meeting":"gbos_9HoIM5INxpI","from":"0:01:56","to":"0:02:07"}'
```

From TypeScript:

```ts
import { callTool, toAgentTool, toolContext, tools } from "@open-minutes/tools";

const ctx = toolContext(db); // or toolContext(async () => openDb())
const agentTools = tools.map((t) => toAgentTool(t, ctx));
```

## Audio tools

Diarization and recognition make mistakes the transcript's text can't show:
two people folded under one label, or speech the recognizer skipped. The
tools in `src/audio/` look at the audio itself. They take a golden fixture
name or a database meeting id. Its audio is downloaded into the per-machine
cache (`~/.cache/open-minutes/meetings/<youtubeId>/`) on first use, and speech
runs, which are slow to compute, are cached there too. Times are `H:MM:SS.ss`
like golden PSV files, so they go straight into a psvtool op. The models run
in `@open-minutes/pipeline/audio`.

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
