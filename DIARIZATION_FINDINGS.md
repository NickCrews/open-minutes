# Diarization — Findings & Handoff

_Written 2026-05-23. Picks up where the OpenWhispr offline-diarization port
(`speaker-identification-walkthrough.html`) was implemented in `packages/pipeline`._

## TL;DR

**RESOLVED (2026-05-23).** The over-clustering (162 "speakers" for a 166-min
meeting) had two compounding causes, both now fixed:

1. **Root cause — wrong embedding model.** A prior session had swapped the CAM++
   model from `zh_en-common_advanced` (192-dim) to `en_voxceleb` (512-dim).
   en_voxceleb produces *muddy* embeddings on GBOS audio: different speakers sit
   at ~0.45–0.50 cosine, overlapping the same-speaker range (~0.76), so clustering
   can't separate them and fragments badly. zh_en-common_advanced separates
   cleanly (different speakers ≤0.25, same-speaker ~0.69). **Switched back to
   zh_en** (and updated `N_DIMENSIONS` 512→192 + migration; text_embedding got its
   own 384-dim constant since it's a different model/space).
2. **Long-meeting drift.** Even with good embeddings, sherpa's agglomerative
   clustering over-splits long recordings (74 clusters in 60 min). Added a
   **post-clustering centroid merge** (`mergeThreshold=0.5`) in `diarize.ts`.

Result on `9HoIM5INxpI`: **3-min clip 11→4 speakers, 60-min clip 74→12, full
166-min meeting 162→18** (≈5 substantial speakers = the board, + a tail of brief
one-off public commenters with genuinely distinct voiceprints). All realistic.
No fixed speaker cap was used (decision #4 honored). Also bumped the diarizer to
`numThreads=4` — the full meeting now diarizes in ~12 min wall (was timing out
the 15-min test budget at 2 threads).

The sections below are the original problem write-up + the diagnostic data that
drove the fix; kept as a record.

## What was built this session

| File | What |
| --- | --- |
| `packages/pipeline/src/diarize.ts` | `diarizeAudio(audio) → DiarizationTurn[]` (sherpa-onnx `OfflineSpeakerDiarization`) and `computeSpeakerEmbeddings(audio, turns) → Map<number, Float32Array>` (CAM++ `SpeakerEmbeddingExtractor`, 3 longest turns ≥1.5s, 8s cap, mean centroid). Lazy model singletons + CLI. |
| `packages/pipeline/src/align.ts` | `alignSpeakers(words, turns)` — word-level overlap match (nearest-midpoint fallback), regroup into `segmented` runs. Plus `segmentsToTurns()` to re-derive turns from an existing golden. |
| `packages/pipeline/src/diarize.test.ts` | Slow (`slow5min`) snapshot test. Preserves golden words, rewrites speaker labels under `SNAPSHOT_UPDATE=1`. |
| `packages/pipeline/src/transcribe.test.ts` | `SNAPSHOT_UPDATE` now **preserves** existing speaker labels instead of writing `unlabeled` (re-transcribes words, re-applies golden turns). Also fixed the bogus `test_wavs/zh.wav` entry → `en/fr/es/de`. |
| `packages/pipeline/src/sherpa-onnx-node.d.ts` | Replaced the wrong `createOfflineSpeakerDiarization` factory with the real `OfflineSpeakerDiarization` class; added `SpeakerEmbeddingExtractor` + `OnlineStream`. |
| `packages/pipeline/src/model.ts` | `tar -xj --strip-components=1` (release tarballs wrap in a folder → were double-nesting). `ensureDownloaded` now checks the *files*, not just the dir, so an empty/partial model dir self-heals. |
| `packages/core/package.json` | Added `./voice_embeddings` export. |
| `packages/pipeline/package.json`, `.gitignore` | Removed dead `download-models` script + stale comment (models now download lazily on first use). |
| `PLAN.md` | Constants → 0.55 / 1.5s; documented the `align.ts` step. **NOTE: the 0.55 threshold is now known to be wrong for GBOS — see below.** |

### Cleanup TODO
- ~~Delete `diarize-sweep.tmp.ts`~~ **done** (also removed `diarize-diag.tmp.ts`, the centroid-similarity diagnostic that produced the data below).

## What works (verified)
- `pnpm typecheck` passes.
- Both ONNX models download + extract flat: `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` and `3dspeaker_speech_campplus_sv_en_voxceleb_16k/...onnx`. (The "speaker-recongition-models" tag in the URL is upstream's typo and is correct.)
- `diarizeAudio` returns sorted turns; `computeSpeakerEmbeddings` returns 512-dim centroids; `alignSpeakers` re-segments correctly; PSV round-trips.

## The problem: over-clustering on long meetings

sherpa-onnx's `OfflineSpeakerDiarization` uses agglomerative clustering with a
cosine **threshold** (larger threshold → fewer clusters). Auto-detect
(`numClusters=-1`) with the walkthrough's `threshold=0.55` produced:

- **Full meeting `9HoIM5INxpI` (166 min): 162 distinct speaker clusters.** A few
  real-looking dominant clusters (spk-0: 365 segs, spk-3: 225, spk-1: 217) plus
  a long tail of ~150 singleton/tiny clusters.

Threshold sweep (`diarize-sweep.tmp.ts`), distinct speakers:

| threshold | 3-min clip | 60-min clip (`audio-short.wav`) |
| --- | --- | --- |
| 0.5  | 10 | — |
| 0.55 | — | (166-min full: **162**) |
| 0.6  | 7  | — |
| 0.7  | 7  | **41** |
| 0.8  | 5  | **31** |
| 0.9  | 6  | not measured (sweep killed; 60-min `process()` is very slow) |

**Conclusion: threshold tuning alone is not enough.** Even 0.8 leaves 31 clusters
in 60 minutes (→ ~80 extrapolated for the full meeting). The 3-min column shows
the dynamic range is narrow (0.5→10 vs 0.9→6), so pushing the threshold higher
buys little. The count scales with duration; a single global threshold can't
hold the speaker count stable across a 166-minute recording. (0.9/0.95 on the
60-min clip weren't finished — each run takes many minutes — but the 0.7→41,
0.8→31 trend is already conclusive.)

### Why OpenWhispr didn't hit this
OpenWhispr is built for short calls with a handful of participants, and it
**caps** the result with `capSpeakerClusters(8)` (keeps the 8 biggest by
talk-time, dumps everyone else into the dominant speaker). That cap hides the
long tail. We deliberately skipped the cap (it's wrong for GBOS: a board meeting
+ public comment can have 15+ legitimate speakers, and dumping the tail into one
person is lossy). So GBOS needs *better* clustering than OpenWhispr, not the cap.

## Decisions already made with the user (don't re-litigate)
1. `diarize.ts` is **pure compute** (turns + embeddings). Alignment is its own module (`align.ts`). No DB, no identify here.
2. **Two functions** (`diarizeAudio`, `computeSpeakerEmbeddings`), lazy model load.
3. Snapshot testing via `SNAPSHOT_UPDATE`, **shared** `golden.psv`: transcribe test owns words, diarize test owns speaker labels, neither clobbers the other (symmetric merge). User will hand-tune the golden afterward.
4. **No hard speaker cap** (rejected `capSpeakerClusters`). ← This is what makes the over-clustering visible; the fix must respect "no crude cap."

## Recommended next step
Add a **post-clustering centroid merge** in `diarize.ts` (reuses the centroid +
cosine code already there):
1. Run `process()` as today (with a higher base threshold, ~0.7–0.8).
2. Compute each cluster's centroid (already implemented).
3. Agglomeratively merge clusters whose centroid cosine similarity > ~0.5–0.6
   (the same band identify.ts uses), then renumber to contiguous `0..N`.

This collapses the long tail of similar singletons into the real speakers
*without* a fixed cap, and keeps genuinely-distinct speakers separate. It needs
tuning + a sanity check against a hand-labeled meeting.

Alternatives considered: (a) raise `minDurationOn` to drop sub-second segments —
loses real short utterances; (b) push the dedupe into `identify.ts` (merge
unknown-speaker rows by centroid similarity) — viable but leaves the raw turns
messy and makes the golden unusable for review; (c) fixed `numClusters` — count
is unknown and varies per meeting.

Open question for the user: what's an acceptable speaker-count ballpark for a
GBOS meeting (helps set the merge threshold)? And is the zh_en CAM++ variant the
prior dev used worth A/B-ing against en_voxceleb (different embedding → different
distance distribution → different optimal threshold)?

## Performance note (also needs attention)
The 166-min meeting took **~12 min wall / 60+ min CPU** to diarize on CPU
(`numThreads` 2–4). At ~188 videos that's many hours. Consider higher thread
counts, a GPU provider if available, or accepting batch/overnight runs. The
`slow5min` test timeout (15 min) is **tight** for the full meeting and may need
raising, or point the test at a shorter clip.

## How to reproduce
```bash
cd packages/pipeline
# Regenerate goldens (downloads models on first run; SLOW — ~10-15 min/meeting):
SNAPSHOT_UPDATE=1 npx vitest run src/diarize.test.ts
# Threshold sweep on a clip:
npx tsx src/diarize-sweep.tmp.ts ~/.cache/gbos-transcripts/meetings/9HoIM5INxpI/audio-short.wav "0.7,0.8,0.9" skipnum
```
Cached audio clips (handy for fast iteration):
`~/.cache/gbos-transcripts/meetings/9HoIM5INxpI/audio-1800-1980.wav` (3 min),
`audio-short.wav` (60 min), `audio.wav` (166 min, full).
