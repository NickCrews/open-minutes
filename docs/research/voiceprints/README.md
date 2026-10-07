# One voiceprint per person, or a handful?

Status: experiment, 2026-10-07. Reproduce with [`notebook.py`](notebook.py), a
[marimo](https://marimo.io) notebook:

```sh
uvx marimo edit --sandbox docs/research/voiceprints/notebook.py   # explore
uv run docs/research/voiceprints/notebook.py                      # headless
```

The first run downloads the 7 golden meetings' audio from the object store
(~190 MB) and embeds every golden segment (~4 minutes on 4 cores). Both are
cached in `~/.cache/open-minutes/research/voiceprints/`. The notebook needs
nothing from the TypeScript workspace: it uses the same CAM++ model through
sherpa-onnx's Python package, at the same version as `sherpa-onnx-node`.

## Question

Today a person has one voiceprint: the mean embedding of their 3 longest turns
in the meeting where we first heard them (`computeSpeakerEmbeddings`,
`packages/audio/src/embed.ts`). It is never updated. A speaker in a new meeting
is matched to the nearest voiceprint if the cosine similarity is ≥ 0.55
(`packages/ingest/src/identify.ts`).

Would we recognize people better if we kept up to 20 embeddings per person,
from segments picked to vary as much as possible, and matched against the
closest one?

## Method

**Leave one meeting out.** For each of the 7 golden meetings, build voiceprints
from the hand-labelled `identified:` segments of the other 6, then try to
recognize every speaker in the held-out meeting. That gives 165 probes:

- **78 known**: the person also speaks in another golden, so the right answer
  is their name.
- **87 unknown**: 51 named people who speak in no other golden, and 36 unnamed
  `segmented:` voices. The right answer is "new person".

A probe is what the pipeline sees: the mean embedding of a speaker's 3 longest
turns in the held-out meeting. Segments are embedded exactly as `embed.ts`
does: segments of 1.5 s or more, using at most their last 8 s.

**Strategies compared:**

| strategy                | voiceprint                                                                  | score                |
| ----------------------- | --------------------------------------------------------------------------- | -------------------- |
| current                 | mean of the 3 longest segments in the person's first meeting                | cosine               |
| centroid, every meeting | mean of the 3 longest segments in _each_ meeting, then averaged across them | cosine               |
| centroid, all segments  | mean of every segment                                                       | cosine               |
| 20 longest              | the 20 longest segments                                                     | max cosine           |
| 20 random               | 20 random segments                                                          | max cosine           |
| 20 diverse              | k-means into 20 groups, keep the segment nearest each centre                | max cosine           |
| 20 spread               | farthest-point sampling from the medoid                                     | max cosine           |
| 20 diverse, top-3       | as 20 diverse                                                               | mean of best 3       |
| 20 diverse, centroid    | as 20 diverse                                                               | cosine to their mean |

**Metrics.** _Recall_ is the share of known probes given their own name.
_Wrong-name rate_ is the share of all probes given someone else's name: an
unknown voice matched to a known person, or a known person matched to the wrong
one. Taking the max over many exemplars raises every score, impostors' too, so
comparing strategies at one fixed threshold would be unfair. Instead each
strategy is scored on the best recall it reaches within a wrong-name budget,
and the threshold that gets it.

## Results

### Voices barely drift between meetings

The cosine similarity of pairs of segments:

| pair                       | median | 10th pct | 90th pct |
| -------------------------- | -----: | -------: | -------: |
| same person, same meeting  |   0.68 |     0.45 |     0.80 |
| same person, other meeting |   0.66 |     0.46 |     0.78 |
| different people           |   0.18 |     0.04 |     0.34 |

The idea assumes that a voiceprint from one meeting misses how a person sounds
in other meetings. With CAM++ on these recordings that gap is small: segments
from the same meeting are only 0.02 more alike than segments from different
meetings. Most of the spread is between segments in general (short or long,
clean or noisy, speaking or reading aloud), not between meetings.

### Many diverse exemplars don't help

Speaker probes, named speakers only (see the next section for why this view).
1% of 129 probes is a single wrong name:

| strategy                | rank-1 | recall @ ≤1% wrong | recall @ ≤2% | recall @ ≤5% | threshold @ ≤2% |
| ----------------------- | -----: | -----------------: | -----------: | -----------: | --------------: |
| current                 |   0.91 |               0.82 |         0.86 |         0.91 |            0.62 |
| centroid, every meeting |   0.94 |           **0.90** |     **0.91** |     **0.94** |            0.62 |
| centroid, all segments  |   0.92 |               0.82 |         0.86 |         0.92 |            0.67 |
| 20 longest              |   0.92 |           **0.91** |     **0.91** |         0.92 |            0.66 |
| 20 random               |   0.90 |               0.35 |         0.44 |         0.86 |            0.80 |
| 20 diverse              |   0.91 |               0.40 |         0.87 |         0.91 |            0.66 |
| 20 spread               |   0.90 |               0.38 |         0.53 |         0.88 |            0.78 |
| 20 diverse, top-3       |   0.90 |               0.44 |         0.77 |         0.85 |            0.66 |
| 20 diverse, centroid    |   0.92 |               0.82 |         0.86 |         0.90 |            0.68 |

- **Picking exemplars for variety makes things worse**, at strict wrong-name
  budgets. Random, k-means-diverse and farthest-point exemplars include odd
  segments (short, noisy, overlapping speech, someone reading a resolution).
  Odd segments sit nearer _other_ people's voices, so the max over 20 of them
  produces high-scoring impostors, and the threshold has to rise to ~0.8 to
  shut them out, which cuts recall in half. Farthest-point sampling is the
  worst by design: it seeks out exactly those outliers.
- **Rank-1 accuracy is ~0.9 to 0.94 for everything.** With 78 known probes,
  that's a spread of 3 speakers: noise.
- **What helps a little is using more than one meeting**, not more exemplars.
  An average over each meeting's centroid ("centroid, every meeting") and the
  20 longest segments (which, for a recurring person, come from several
  meetings) both recognize ~6 more of the 78 known speakers than "current" at
  a 1 to 2% wrong-name budget. That's a modest effect on a small sample.
- **The number of exemplars doesn't matter much.** Sweeping K over 1, 3, 5, 10,
  20, 40 for the "longest" and "diverse" pickers moves recall around without a
  trend (the notebook's _How many exemplars?_ table).
- **Segment-level probes** (each held-out segment matched alone; 1,400 probes)
  agree on the ranking at the bottom: random, diverse and spread are worst.
  At the top they show no gain over "current" from any strategy, the
  per-meeting average included (recall @ ≤2% wrong: current 0.41, every
  meeting 0.40, 20 longest 0.36).

### The threshold and the goldens matter more than the voiceprint

Including the 36 unnamed voices, "current" at today's 0.55 threshold gives
91% recall but names 11.5% of all probes wrongly. Every strategy needs a
threshold of ~0.6 to 0.7 to get that under 5%.

Some of those wrong names are probably gaps in the goldens, not recognition
errors, which is why the table above leaves the unnamed voices out:

- The unnamed voice that reads resolutions and runs the votes in GBOS
  2026-05-18 and 2026-06-15 (`segmented:spk-0` in both) scores 0.73 and 0.77
  against Jennifer Wingard, who was co-chair then. It's probably her.
- `keith-mccormick` in Assembly 2026-03-03 scores 0.80 against
  `george-martinez` and 0.14 against Keith McCormick's voiceprint from the
  other Assembly meeting. One of the two goldens probably has the wrong name on
  that voice.

## Conclusions

1. **Don't switch to ~20 diverse voiceprints matched by max similarity.** On
   this data it recognizes no more people and, at the wrong-name rates we'd
   accept, recognizes fewer. Variety in the exemplars adds impostor matches
   faster than it adds genuine ones.
2. **Do let a voiceprint learn from more than one meeting.** When a speaker is
   confidently matched (or a person confirms a label), fold that meeting's
   centroid into the person's voiceprint: a running mean of per-meeting
   centroids. It's still one vector per person, so the schema and the pgvector
   query stay as they are, and it's the strategy that did best here. This is
   the "averaging" follow-up already noted in
   [ADR 0002](../../../adrs/0002-two-tier-speaker-identity.md). Updating only
   on confident matches matters: a wrong match folded in would pull the
   voiceprint towards someone else.
3. **Raise the match threshold** from 0.55 to around 0.62 to 0.65. At 0.55 one
   in nine speakers gets someone else's name; most of the gain from a better
   voiceprint is available from the threshold alone.
4. **Fix the goldens first**: name `segmented:spk-0` in GBOS May and June if
   it's Jennifer Wingard, and check Keith McCormick vs George Martinez in the
   Assembly goldens. Every threshold above is tuned partly against those
   labels.

## Caveats

- Probes and voiceprints both come from hand-labelled segments, so every
  "speaker" is a single pure voice. Real diarization clusters are sometimes
  mixed, and real voiceprints would be built from the pipeline's own
  (sometimes wrong) assignments. Both would hurt max-similarity matching more
  than averaging, because one stray exemplar can match anyone.
- 7 meetings, 78 known speaker probes. Differences of a few points are a
  speaker or two.
- One embedding model (CAM++ common_advanced), and every segment is embedded
  from at most its last 8 s, as the pipeline does. A model with more
  session-to-session variation could change conclusion 1.
