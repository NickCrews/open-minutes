# Speaker identity

Every segment of a transcript says who spoke it, as far as anyone knows. There
are two tiers of knowing (see [TERMINOLOGY.md](../TERMINOLOGY.md#speakers-and-people)):

- A **speaker number** is diarization's cluster within one meeting. Speaker 3
  in one meeting has nothing to do with speaker 3 in another.
- A **person** is the same individual in every meeting they speak in, with one
  voiceprint. A known person also has a slug, such as `margaret-tyler`.

A segment with neither is **unattributed**, and may mix several voices.

## One segment type

`Segment` in [`@open-minutes/core/transcript`](../packages/core/src/transcript.ts)
carries both tiers, so the pipeline, the golden transcripts, the rules and the
database share one shape:

```ts
interface Segment<Person = never> {
  speakerNumber: number | null;
  person: Person | null;
  words: Word[];
}
```

`Person` is how a segment names a person where it lives:

| Where                  | Type                          | `person`      |
| ---------------------- | ----------------------------- | ------------- |
| diarization, alignment | `Segment`                     | always null   |
| golden transcripts     | `Segment<string>`             | a slug        |
| the rules              | `Segment<string \| number>`   | either        |
| the `segments` table   | `person_id`, `speaker_number` | a `people.id` |

Diarization and alignment can't know who a voice is; recognition works that
out later, against the voiceprints in `people`. So alignment returns plain
`Segment`s, whose `Person` is `never`: the type leaves them no way to name a
person. Golden transcripts are ground truth, written by a human who knows who
was speaking, so they can.

`speakerKey(segment)` decides whether two segments have the same speaker. A
person outranks a speaker number, so a voice that diarization split across
several numbers is still one speaker; unattributed segments all share one key.
The rules and the web's speaker colors and names both use it.

## In golden transcripts

A PSV `begin_speaker` label holds one tier (see the
[fixtures README](../packages/fixtures/README.md#transcript-format)):

| Label               | `speakerNumber` | `person` |
| ------------------- | --------------- | -------- |
| `unlabeled`         | null            | null     |
| `segmented:spk-<n>` | n               | null     |
| `identified:<slug>` | null            | slug     |

A human labels the recurring voices they recognize `identified:<slug>` and
leaves the rest `segmented:spk-<n>`. The prefix makes "is this a known
person?" a property of the label rather than a guess from the slug's shape.
Serializing a segment with both a person and a speaker number throws, since
one label can't hold both.

## In the database

`segments.person_id` and `segments.speaker_number` are both nullable: both
null is unattributed, a number alone is diarized but not yet recognized, and
a person may come with or without the number it was recognized from.

`people.slug` is the cross-meeting join key for known people. It names the
same person in every database (prod, dev and each test database), where
`people.id` depends on insert order. People created for a recurring but
unnamed voice have no slug.

## Seeding

Seeding a golden meeting writes each segment's speaker number and person
straight to those columns, looking up each slug's `people.id`. One person row
is created per slug, however many seed meetings they speak in. A dataset whose
spec sets `"voiceprints": "audio"` builds each known person's voiceprint from
the audio of their segments in the first seed meeting they speak in, with the
same `computeSpeakerEmbeddings`
that diarization uses, so seeded voiceprints are in the space recognition
compares against. Other datasets use placeholder voiceprints.
