# ADR 0002: Two-tier speaker identity and cross-meeting recognition

Date: 2026-07-28
Status: Proposed

## Context

A meeting transcript attributes each run of words to a speaker. Until now
"speaker" meant one thing: a per-meeting diarization cluster,
`speakerNum: number | null` on `TranscriptSegment` (`spk-0`, `spk-1`, …, or null).
That number is invented fresh by the diarizer for each meeting — `spk-3` in one meeting has
no relation to `spk-3` in another.

We want an end-to-end test of the thing the product actually promises: that a
person is _recognized across meetings by their voice_. The scenario:

1. Start from a blank database.
2. Seed it from two golden meetings — transcripts **and** a voiceprint per known
   person.
3. Ingest a third meeting's audio through the real pipeline.
4. Compare that ingestion against the third golden — did we transcribe it well,
   and did we put the right names to the voices?

For step 4 to mean anything, "Margaret" in golden 1 has to be the _same identity_
as "Margaret" in golden 3. A per-meeting cluster number cannot express that. We
need a speaker identity that is stable across meetings.

## Decision

### Two tiers of speaker identity

Model speaker attribution as two distinct kinds, not one number:

- **Local diarization cluster** — a voice the diarizer separated within one
  meeting but that we have not tied to a known person. Meaningful only inside its
  meeting.
- **Global person identity** — a recurring person (Margaret), keyed by a stable
  **slug** that denotes the same individual in every meeting, backed by a
  voiceprint stored in the `people` table.

The bridge from raw audio to a global identity is the voiceprint: diarization
produces anonymous local clusters, then `identify.ts` matches each cluster's
voiceprint against the stored people and resolves the ones it recognizes.

### Golden format encodes both, explicitly

The PSV `begin_speaker` label carries the tier in its prefix (the grammar already
reserved these; we make them load-bearing):

- `unlabeled` — no speaker info.
- `segmented:spk-<n>` — a local cluster.
- `identified:<slug>` — a global person (eg `identified:margaret-tyler`).

A human labels the recurring voices they recognize as `identified:<slug>` and
leaves the rest as `segmented:spk-<n>`. We chose an explicit `identified:` prefix
over overloading `segmented:` with names, so "is this a known person?" is a
property of the data, not a guess from whether the slug looks like `spk-N`.

### Two types, not one — diarization stays identity-blind

The live pipeline's `TranscriptSegment` keeps `speakerNum: number | null`
unchanged. Diarization and alignment cannot know _who_ a voice is — identification
happens later, against the database — so pushing an `identified` case into them
would add a state they can never produce. The richer representation lives only on
the golden side:

```ts
type SpeakerLabel =
  | { kind: "unlabeled" }
  | { kind: "segmented"; cluster: number }
  | { kind: "identified"; person: string };

interface GoldenSegment {
  speaker: SpeakerLabel;
  words: TranscriptWord[];
}
```

The golden is ground truth, so it _can_ carry the identified-person answer the
pipeline has to work out. `toGoldenSegment()` lifts a pipeline segment (a bare
cluster) into a `GoldenSegment`; nothing converts the other way, because the
pipeline never asserts an identity.

Consequence for the snapshot refresh: the transcription-snapshot path can no
longer round-trip golden speakers through the numeric diarization turn (that would
erase the hand-assigned people). Instead `reapplySpeakerLayer()` redistributes
freshly transcribed words back into the existing golden's segments by time,
preserving both the cluster boundaries and the `identified` labels.

### `people.slug`

Add a unique, nullable `slug` to `people`. Seeded/known people carry a slug;
people auto-created during ingestion (a distinct but unknown voice) keep it null,
as today. The slug is the cross-meeting join key — the fact that makes
"the Margaret recognized here is the same row as there" true rather than
coincidental.

### End-to-end seeding

`seedGoldenMeeting()` seeds a hand-verified golden as established truth: it inserts
the meeting and its segments, and builds one voiceprint per `identified` person
from the audio spans they speak (reusing the pipeline's own
`computeSpeakerEmbeddings`, so seeded voiceprints live in the same embedding space
the pipeline matches against). People are upserted by slug, so a person recurring
across seed meetings is a single row.

The e2e test then ingests a third meeting through the unmodified `ingestVideo`
pipeline — which sees only audio — and scores the result against the third golden:
word error rate, plus (once the third golden is hand-labeled) how often the right
person was recognized.

## Alternatives considered

- **String label everywhere, including the DB.** Replace `speaker_number:
integer` with a text label and thread strings through diarize/align/identify.
  Rejected: it forces the identity-blind stages to carry an `identified` case they
  never produce, and rewrites a working numeric column for no pipeline benefit.
- **Keep everything under `segmented:` and infer person-ness from the slug shape.**
  Rejected: makes a core distinction implicit in a naming convention.
- **Reuse `people.name` as the cross-meeting key.** Rejected: `name` is a nullable
  human display string; using it as an identity key is exactly the leaky shortcut
  a slug exists to avoid.

## Status / follow-ups

- The held-out third golden is a rough first-pass transcript; e2e thresholds are
  deliberately lax and identification accuracy is only scored once the third
  golden has `identified` people. Tighten as the fixture is hand-cleaned.
- Voiceprint accumulation across seed meetings is first-wins; averaging is a
  possible later refinement.
