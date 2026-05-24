# GBOS Meeting Transcript Database

## Context

The Girdwood Board of Supervisors (GBOS) publishes meeting recordings on [YouTube](https://www.youtube.com/channel/UCOUlNInprZEjhbpVPiJOlEA) (~188 videos). There's no searchable archive of what was said, by whom, or when. This project creates an audio+transcript database with lexical search and a daily update pipeline — enabling citizens and AI agents to find when GBOS discussed any topic.

The data model is designed to be **municipality-agnostic** so additional government bodies can be added later.

## Prior Art Considered

- **Council Data Project**: Open-source, Python+TS, closest match — but uses Google Cloud services and Firebase
- **MeetingBank**: Research dataset covering 6 municipalities with agenda-item-linked transcripts. Our schema follows its structure: meetings contain agenda items, agenda items contain transcript segments with timing info
- **Hamlet / OpenCouncil / Councilmatic**: Production platforms, SaaS or tightly coupled to their own infra
- **OpenWhispr**: Open-source meeting assistant using sherpa-onnx for local speaker diarization — our diarization pipeline follows their architecture

## Tech Stack

| Component          | Choice                                                      | Why                                                                       |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Download           | `yt-dlp` (CLI)                                              | Best YouTube downloader, audio-only extraction                            |
| Audio utils        | `ffmpeg`                                                    | Industry standard. Fast and easy to install.                              |
| Transcription      | `sherpa-onnx` (NeMo Parakeet TDT 0.6b v3, INT8)             | Fast ONNX transducer ASR via native Node.js bindings, no Python           |
| Diarization        | `sherpa-onnx`                                               | Native ONNX bindings, no Python/GPU, ~30s for 45-min meeting on M1        |
| Speaker embeddings | CAM++ via sherpa-onnx (512-dim)                             | Half the params of ECAPA-TDNN, lower EER, fast CPU inference, ONNX export |
| Database           | Postgres + pgvector + Drizzle ORM                           |                                                                           |
| Pipeline           | TypeScript + Node.js via `tsx`/`pnpm`                       | Unified stack — no Python sidecar, no runtime boundary                    |
| Web App            | SolidJS + TanStack Start + TanStack Router                  | SSR-capable frontend with file-based routing, server functions            |

**No Python required.** All ML runs through ONNX models loaded either by `sherpa-onnx` (transcription, diarization). The only native dependency is `ffmpeg` for audio decoding.

## Diarization Architecture

Follows the [OpenWhispr local diarization approach](https://openwhispr.com/blog/local-speaker-diarization), implemented entirely through sherpa-onnx native Node.js bindings. That walkthrough describes the online algorithm that happens live.
We actually just use their process that they use offline, which is slightly different from what they describe
in that blog (inferred from reading their source code):

1. **pyannote-3.0 segmentation** (~6.6MB ONNX) — identify speaker boundaries and overlapping speech
2. **CAM++ embeddings** (~28MB ONNX) — 512-dim voice fingerprints per segment
3. **Agglomerative clustering** — group embeddings at 0.5 cosine-similarity threshold

**Minimum segment duration**: 0.8 seconds for reliable CAM++ embedding extraction.

### How it works

1. **Diarization** (`pipeline/src/diarize.ts`): sherpa-onnx produces speaker embeddings per speaker (mean-pooled over their 3 longest segments).

2. **Identify** (`pipeline/src/identify.ts`): For each speaker embedding, query `people` by cosine distance:

   ```sql
   SELECT id FROM people
   WHERE voice_embedding <=> $vec::vector < 0.45  -- similarity > 0.55
   ORDER BY voice_embedding <=> $vec::vector
   LIMIT 1
   ```

   Confidence tiers (matching OpenWhispr):
   - **≥ 0.70 similarity**: auto-confirm
   - **0.55–0.70**: suggest (auto-confirm for now, can add UX prompt later)
   - **< 0.55**: create new `Unknown Speaker` row

3. **Link segments**: Each aligned transcript segment gets `person_id` set to the matched or newly-created person.

It is also designed to be **source-agnostic**. YouTube is the only ingestion source today, but Vimeo, direct uploads, and municipality-hosted streams are all plausible tomorrow. A meeting therefore has its own internal id (`meetings.id`, the integer primary key), and the YouTube video id is just one *attribute* of that meeting (its source identifier). All downstream code — pipeline stages, cache paths, function signatures, test fixtures — should key off the internal meeting id, not the YouTube id. See "Open: source abstraction" below for the planned schema follow-up.