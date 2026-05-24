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
| Speaker embeddings | CAM++ via sherpa-onnx (zh_en-common_advanced, 192-dim)      | Half the params of ECAPA-TDNN, lower EER, fast CPU inference, ONNX export. The common_advanced variant separates speakers far more cleanly on GBOS audio than en_voxceleb. |
| Database           | Postgres + pgvector + Drizzle ORM                           |                                                                           |
| Pipeline           | TypeScript + Node.js via `tsx`/`pnpm`                       | Unified stack — no Python sidecar, no runtime boundary                    |
| Web App            | SolidJS + TanStack Start + TanStack Router                  | SSR-capable frontend with file-based routing, server functions            |

**No Python required.** All ML runs through ONNX models loaded either by `sherpa-onnx` (transcription, diarization). The only native dependency is `ffmpeg` for audio decoding.

## Diarization Architecture

Follows the [OpenWhispr local diarization approach](https://openwhispr.com/blog/local-speaker-diarization), implemented entirely through sherpa-onnx native Node.js bindings. That walkthrough describes the online algorithm that happens live.
We actually just use their process that they use offline, which is slightly different from what they describe
in that blog (inferred from reading their source code):

1. **pyannote-3.0 segmentation** (~6.6MB ONNX) — identify speaker boundaries and overlapping speech
2. **CAM++ embeddings** (~28MB ONNX, zh_en-common_advanced) — 192-dim voice fingerprints per segment
3. **Agglomerative clustering** — group embeddings at a 0.55 cluster threshold (auto-detecting the speaker count, no hard cap)
4. **Post-clustering merge** — sherpa's raw clustering over-splits long meetings (one speaker drifts into many sub-clusters; a 166-min meeting produced ~160 "speakers"). We re-merge any two clusters whose centroids are within `mergeThreshold=0.5` cosine, then fold tiny no-voiceprint clusters into the nearest-in-time speaker. This collapses the long tail without a fixed speaker cap. See `DIARIZATION_FINDINGS.md`.

**Minimum segment duration**: 1.5 seconds for reliable CAM++ embedding extraction.

Constants mirror OpenWhispr's offline path: `clusterThreshold=0.55`, `numClusters=-1`, `minDurationOn=0.2s`, `minDurationOff=0.5s`, 3 longest segments per centroid, `minSegment=1.5s`, `maxEmbedding=8s`, plus our `mergeThreshold=0.5`. The diarizer's cluster/merge thresholds are deliberately separate from the recognition thresholds in `identify.ts`.

### How it works

1. **Diarization** (`pipeline/src/diarize.ts`): `diarizeAudio()` returns anonymous, time-stamped speaker turns (post-clustering merge applied, speakers renumbered 0..N by talk time); `computeSpeakerEmbeddings()` builds one 192-dim CAM++ centroid per speaker (mean-pooled over their 3 longest turns). Both run in-process via sherpa-onnx native bindings — no subprocess binary, no worker threads.

2. **Align** (`pipeline/src/align.ts`): `alignSpeakers()` attaches a speaker to each transcript word by time overlap (nearest-midpoint fallback) and regroups consecutive same-speaker words into segments.

3. **Identify** (`pipeline/src/identify.ts`): For each speaker embedding, query `people` by cosine distance:

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

4. **Link segments**: Each aligned transcript segment gets `person_id` set to the matched or newly-created person.

It is also designed to be **source-agnostic**. YouTube is the only ingestion source today, but Vimeo, direct uploads, and municipality-hosted streams are all plausible tomorrow. A meeting therefore has its own internal id (`meetings.id`, the integer primary key), and the YouTube video id is just one *attribute* of that meeting (its source identifier). All downstream code — pipeline stages, cache paths, function signatures, test fixtures — should key off the internal meeting id, not the YouTube id. See "Open: source abstraction" below for the planned schema follow-up.