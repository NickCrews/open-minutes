# Ubiquitous Language

The shared vocabulary for Open Minutes. Use these words, with these meanings, in
code, comments, docs, UI copy, commit messages, issues, and agent instructions.
When you catch yourself reaching for a word in an "Aliases to avoid" column,
use the canonical term instead. If a concept is missing or a definition is
wrong, fix this file in the same change that introduces the new meaning.

Identifiers in `code font` are where the term lives today (table, column, type,
or file). The canonical term is what we _say_; the identifier may lag behind it.
Mismatches are listed under [Flagged ambiguities](#flagged-ambiguities).

## Governments and bodies

| Term             | Definition                                                                                                                                          | Aliases to avoid                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Jurisdiction** | A government with geographic boundaries (the Municipality of Anchorage) that contains bodies but never meets itself. `jurisdictions`                | municipality, muni, city, town, government, org         |
| **Body**         | A deliberative group that holds meetings (the Girdwood Board of Supervisors, the Anchorage Assembly) inside exactly one jurisdiction. `bodies`      | muni, board, council, committee, organization, group    |
| **Body slug**    | The lowercased `name_short` of a body (eg `gbos`), used in CLI filters and work-directory names. `bodySlug()`                                       | muni slug, body id, short name                          |
| **Video source** | A YouTube channel or playlist that ingestion scans for a body's meeting videos; one body may have several and one channel may serve several bodies. | feed, channel (unless it really is a channel), playlist |

"Municipality" appears only as part of a jurisdiction's proper name ("Municipality
of Anchorage"). The adjective "municipal" is fine in reader-facing prose; the
_entity_ is a jurisdiction. The web UI's reader-facing heading for bodies is
"Boards & Councils" (see flagged ambiguities).

## Meetings and transcripts

| Term                                | Definition                                                                                                                                                         | Aliases to avoid                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Meeting**                         | One gathering of one body, recorded as one video, and the unit we ingest, store, and display. `meetings`                                                           | session, hearing, video, event, recording                  |
| **Video**                           | The YouTube recording of a meeting, identified by its `youtube_id`; the meeting's audio comes from it.                                                             | stream, clip, media                                        |
| **Meeting date** / **meeting time** | The local wall-clock day, and optionally time of day, a meeting gavelled in, in its body's `timezone`. A null time means "time unknown" (ADR 0003). `date`, `time` | start time, start_time (removed), timestamp                |
| **Transcript**                      | The ordered segments of one meeting: everything that was said, who said it, and when.                                                                              | minutes, captions, transcription (for the artifact), notes |
| **Word**                            | One recognized word and its onset, the atomic unit of a transcript. `TranscriptWord`                                                                               | token, term                                                |
| **Onset**                           | The number of seconds from the start of the meeting's audio to where a word begins; words store no end time. `TranscriptWord.start`                                | timestamp (ambiguous), meeting time (that's the meeting's) |
| **Segment**                         | A non-empty run of consecutive words spoken by one speaker; its text and times are derived from its words. `segments`, `TranscriptSegment`                         | utterance, turn, bubble, block, paragraph, line, clip      |
| **Speaking time**                   | The total duration of a speaker's segments within one meeting, as shown in the meeting page's Speakers list.                                                       | talk time, airtime                                         |
| **Minutes** (avoid)                 | Formal written minutes are _not_ something this project produces. Open Minutes publishes transcripts; say "transcript" unless you mean the legal record.           | —                                                          |

## Speakers and people

Speaker identity has two tiers (see [ADR 0002](adrs/0002-two-tier-speaker-identity.md)):
a **speaker** is local to one meeting, a **person** is global across all meetings.

| Term                 | Definition                                                                                                                                                           | Aliases to avoid                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Speaker**          | A distinct voice within one meeting, as displayed in that meeting's transcript; meaningful only inside its meeting. `SpeakerIdentity`                                | person (when you mean per-meeting), participant, attendee |
| **Speaker number**   | The per-meeting integer the diarizer assigns to a cluster (`0` talks most); `3` in one meeting has nothing to do with `3` in another. `speaker_number`, `speakerNum` | speaker id, speaker index, spk (outside PSV)              |
| **Person**           | A recurring individual, the same row in every meeting they speak in, backed by exactly one voiceprint. `people`                                                      | speaker, user, member, voice, profile                     |
| **Known person**     | A person with a slug, seeded from test data or otherwise established by a human as a specific individual.                                                            | identified person (outside PSV), seeded speaker           |
| **Slug**             | A stable, globally-unique handle for a known person (`margaret-tyler`); the cross-meeting identity key. `people.slug`                                                | name, id, handle                                          |
| **Name**             | The human-entered display name of a person; null until someone enters it, and never used as a key. `people.name`                                                     | label, slug                                               |
| **Named person**     | A person whose name is set.                                                                                                                                          | identified person, known person                           |
| **Anonymous person** | A person whose name is null: a distinct voice ingestion recognized as recurring but no one has put a name to yet.                                                    | unknown person, unidentified person, unnamed speaker      |
| **Placeholder name** | The per-meeting "Anonymous &lt;Animal&gt;" label the UI gives an anonymous speaker; never stored and differs from meeting to meeting.                                | fake name, alias                                          |
| **Unattributed**     | A segment with neither a person nor a speaker number, rendered as "Unknown" with no color because it may mix several voices.                                         | unlabeled (outside PSV), anonymous                        |
| **Bio**              | Free-form prose a human writes about a person: role, affiliation, tenure. `people.bio`                                                                               | description, about, title                                 |
| **Attendance**       | For one person and one body, the count and date span of that body's meetings the person spoke in. `Attendance`                                                       | membership, roster, participation                         |

## Voice and recognition

| Term            | Definition                                                                                                                                                           | Aliases to avoid                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Voiceprint**  | A 192-dimensional vector summarizing one voice (the averaged embeddings of a speaker's longest turns); a person has exactly one. `people.voice_embedding`            | voice embedding (in prose), speaker embedding, fingerprint |
| **Embedding**   | Any fixed-length vector produced by a model; today only voice embeddings exist, in the CAM++ voice space. `voice_embeddings/`                                        | vector (alone), feature                                    |
| **Cluster**     | A group of diarization turns the diarizer believes share one voice; after merging, each cluster gets a speaker number.                                               | speaker (inside the pipeline), group                       |
| **Recognition** | Matching a speaker's voiceprint against every person's voiceprint and linking to the nearest one within threshold, or creating a new anonymous person. `identify.ts` | identification, matching, labeling                         |

## Pipeline

| Term                 | Definition                                                                                                                                                       | Aliases to avoid                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Ingestion**        | Running one video through download, transcription, diarization, alignment, and recognition, then committing the meeting and its segments atomically. `om ingest` | import, processing, scraping, sync                      |
| **Available video**  | A video on one of a body's video sources that has not been ingested yet. `om available`                                                                          | new video, pending video, backlog                       |
| **Transcription**    | The pipeline stage that turns audio into words with onsets; the _process_, not the artifact (that's the transcript). `transcribe.ts`                             | ASR (in prose), speech-to-text, captioning              |
| **Speech run**       | A stretch of audio between silences found by voice-activity detection (VAD) and fed to the recognizer; speaker-agnostic. `SpeechSegment`                         | segment (reserve that for speaker segments), chunk      |
| **Diarization**      | The pipeline stage that splits audio into diarization turns and clusters them by voice, knowing nothing about who anyone is. `diarize.ts`                        | speaker detection, segmentation (alone), identification |
| **Diarization turn** | One time span during which the diarizer heard one cluster speaking; has a start, end, and speaker number but no words. `DiarizationTurn`                         | segment, turn (alone is ok inside diarize.ts)           |
| **Alignment**        | The pipeline stage that assigns each word to the diarization turn it overlaps most and groups consecutive same-speaker words into segments. `align.ts`           | merging, matching                                       |
| **Work directory**   | The per-meeting cache of stage outputs (audio, transcription, diarization) under `packages/pipeline/data/meetings/<body-slug>_<youtube_id>/`.                    | cache dir, temp dir                                     |

## Test data and evaluation

| Term                     | Definition                                                                                                                                                            | Aliases to avoid                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Golden transcript**    | A human-reviewed, checked-in transcript used as ground truth for a meeting, stored as PSV at `test-data/meetings/<body-slug>_<youtube_id>/golden.psv`.                | fixture (alone), snapshot, expected output, reference |
| **Golden meeting**       | A test-data meeting directory: its `meeting.json` metadata, its golden transcript, and its cached audio. `GoldenMeeting`                                              | test meeting, sample                                  |
| **Generated transcript** | A fresh pipeline transcript a test writes to its run directory as `*.gen.psv` for inspection, including debug `vad` lines; never ground truth.                        | golden, output                                        |
| **PSV**                  | The pipe-separated, one-word-per-line format for golden transcripts (`start_sec\|event_type\|event_data`). See [ADR 0001](adrs/0001-psv-golden-transcript-format.md). | CSV, TSV, transcript file                             |
| **Speaker label**        | The tier-tagged speaker of a golden segment: `unlabeled`, `segmented:spk-<n>` (a cluster), or `identified:<slug>` (a known person). `SpeakerLabel`                    | speaker tag, speaker id                               |
| **Test data**            | The checked-in jurisdictions, bodies, people, and golden meetings under `packages/pipeline/test-data/` that `pnpm db:seed` loads.                                     | fixtures, seed data (as the noun for the files)       |
| **Seeding**              | Loading test data into a database as established truth, including building a voiceprint for each known person from their golden segments.                             | importing, populating                                 |
| **WER**                  | Word error rate: (substitutions + deletions + insertions) / reference word count, comparing a pipeline transcript to a golden transcript.                             | accuracy, error                                       |

## Not (yet) in the domain

These words come up but name nothing in the system today. Don't use them as if
they did; when one becomes real, define it here first.

- **Chapter** / **agenda item** / **topic**: no subdivision of a meeting above the segment exists yet.
- **Text embedding**: `voice_embeddings/index.ts` alludes to a text/lexical embedding space; there is none. Search is a plain substring match on segment text.
- **Minutes**: see above; we produce transcripts.
- **Member**, **role**, **term of office**: not modelled; that information lives only in a person's free-form bio.

## Relationships

- A **jurisdiction** contains one or more **bodies**; each body belongs to exactly one jurisdiction.
- A **body** has zero or more **video sources** and zero or more **meetings**. A video source belongs to one body, though the same YouTube channel may be registered as a video source for several.
- A **meeting** belongs to exactly one body and has at most one **video**. Its **transcript** is its ordered **segments**.
- A **segment** belongs to exactly one meeting, contains one or more **words** in order, has at most one **speaker number**, and is linked to at most one **person**.
- A **speaker** is one meeting's view of a voice: keyed by person when the segment has one, else by speaker number, else **unattributed**. One person is one speaker per meeting, even if diarization split them across several speaker numbers.
- A **person** has exactly one **voiceprint**, at most one **slug**, and at most one **name**. A known person always has a slug; a named person always has a name; the two are independent.
- **Ingestion** runs **transcription** (audio → words), **diarization** (audio → diarization turns), **alignment** (words + turns → segments), then **recognition** (speaker voiceprints → persons).
- A **golden meeting** has exactly one **golden transcript**; its **speaker labels** carry the two tiers explicitly, which the database expresses as `speaker_number` (segmented) versus `person_id` with a slug (identified).

## Example dialogue

> **Dev:** When we ingest a new GBOS video, does diarization tell us Margaret was there?
>
> **Domain expert:** No. Diarization only gives clusters: speaker 0, speaker 1, and so on. Speaker numbers are local to that meeting. Recognition then compares each speaker's voiceprint with every person's and links the segments to Margaret's person row if hers is close enough.
>
> **Dev:** And if nobody is close enough?
>
> **Domain expert:** Recognition creates a new anonymous person. Their segments show up under a placeholder name like "Anonymous Beaver", and that placeholder differs in the next meeting. Once someone types a name on the person page, it becomes a named person everywhere at once.
>
> **Dev:** So a named person isn't the same thing as a known person?
>
> **Domain expert:** Right. A known person has a slug, which is what the golden transcripts use in `identified:margaret-tyler`. Naming is just the display name. Never join on names.
>
> **Dev:** And the "Anchorage" in all this is a body?
>
> **Domain expert:** The Municipality of Anchorage is a jurisdiction. It never meets. The Assembly and GBOS are bodies inside it, and meetings hang off bodies.

## Flagged ambiguities

Places where the code or copy disagrees with this glossary. Items marked
**fixed** were cheap, safe doc/UI renames done when this file was introduced;
the rest are left for a deliberate change because they touch schema, APIs, or
product decisions.

1. **"muni" for body** (**fixed**): `packages/pipeline/README.md` said `--muni <slug>`,
   "muni channels", and `<muni-slug>`. The CLI flag is actually `--body`, and
   the concept is a body's video sources. The `jurisdictions`/`bodies` split
   (migration `split-munis-into-jurisdictions-and-bodies`) retired "muni".
2. **"Identified" means three different things.** (a) In PSV/ADR 0002,
   `identified:<slug>` means a **known person**. (b) In `identify.ts`, identifying
   means **recognition**, which usually _creates an anonymous person_ and so
   identifies no one. (c) In `features/people`, "unidentified" means a person
   with no **name** (`updatePersonName`) _and_ a segment with no person
   (`getAttendanceByPerson`). Prefer **known**, **recognized**, **named**, and
   **unattributed** respectively. Renaming `identify.ts` →
   `recognize.ts` / `identifyAndInsertSegments` is a candidate follow-up.
3. **"Segment" is overloaded.** A speaker **segment** (`segments`,
   `TranscriptSegment`) versus a VAD **speech run** (`SpeechSegment`) versus
   pyannote's "segmentation" model (which produces **diarization turns**) versus
   the PSV `segmented:` label (which means **cluster**). In prose, "segment"
   always means the speaker segment. Renaming `SpeechSegment` → `SpeechRun`
   would remove the worst collision; the code already calls them "runs".
4. **Voiceprint vs. voice embedding vs. speaker embedding vs. centroid.** The
   column is `people.voice_embedding`, the function is `computeSpeakerEmbeddings`,
   and comments say "voiceprint" and "centroid". All mean **voiceprint**. The
   names are left alone (schema/API); use "voiceprint" in prose.
5. **"Tier A / Tier B" collides with ADR 0002's two tiers.** Comments in
   `diarize.ts` / `embed.ts` call segmentation "Tier A" and the embedding
   toolkit "Tier B" (OpenWhispr's terms), while ADR 0002's two tiers are
   speaker vs. person. Prefer "diarization" and "voiceprints" in those comments.
6. **Body in the UI is "Boards & Councils", but the rest of the page says "body".**
   `/bodies` is headed "Boards & Councils" while its empty state reads "No bodies
   yet." and meeting pages link "View body →". "Body" is jargon to readers, so a
   friendlier label may be right, but it should be one label used everywhere in
   the UI. Left for a product decision.
7. **Anonymous people render three ways.** "(unnamed)" on the People list,
   search results and person page; "Anonymous &lt;Animal&gt;" in transcripts;
   "Unknown" for unattributed segments. The first two are the same concept
   (anonymous person) seen from global vs. per-meeting views, which is
   deliberate, but "(unnamed)" could read "Anonymous person" for consistency.
8. **People are described as "identified"** (**fixed**): the home page said
   "Speakers identified across meetings.", but most people are anonymous and
   "speaker" is per-meeting. Now "People recognized by voice across meetings."
9. **Search is not full-text** (**fixed**): the home page promised "Full-text
   search"; `searchSegments` is a case-insensitive substring match on segment
   text. Now "Search what was said across all transcripts."
10. **"Snapshot" means two things.** The seeding code calls the whole
    `test-data/` tree a "snapshot", while `SNAPSHOT_UPDATE=1` (and ADR 0002's
    "transcription-snapshot path") means regenerating golden transcripts from
    the pipeline. Prefer **test data** for the former and "regenerating the
    goldens" for the latter.
11. **"Attendance" measures speaking, not presence.** `Attendance` counts
    meetings where a person has at least one segment; a member who never spoke
    is absent from it. Keep the type name but don't describe it as who attended.
12. **Dangling reference.** `diarize.ts` cites `DIARIZATION_FINDINGS.md`, which
    is not in the repo.
