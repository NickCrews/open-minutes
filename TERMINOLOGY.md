# Open Minutes

Open Minutes turns recordings of local-government meetings into searchable
transcripts that show who said what, recognizing the same person by voice
across meetings. These are the words we use for its concepts, in code, docs,
UI copy, commits, and issues.

## Language

### Governments and bodies

**Jurisdiction**:
A government with geographic boundaries, such as the Municipality of Anchorage, that contains bodies but never meets itself.
_Avoid_: municipality, muni, city, town, government, org

**Body**:
A deliberative group that holds meetings, such as the Girdwood Board of Supervisors, inside exactly one jurisdiction.
_Avoid_: muni, board, council, committee, organization, group

**Slug**:
A stable, unique handle in lowercase kebab-case that names a row the same way in every database, unlike its id, and doesn't change when it's renamed. Code, static data, the fixtures, the command line and file paths refer to a row by it. Every jurisdiction (`moa`) and body (`gbos`) has one; so does every known person (`margaret-tyler`), the key for their identity across meetings, and every golden fixture meeting (`gbos-2026-03-23`, its fixture directory's name). Other meetings and people have none and go by their id.
_Avoid_: name, short name, handle, key, muni slug, body id, fixture name, meeting key

**Glossary**:
The local words of a region, such as Anchorage or Girdwood: what each means and how speech recognition mishears it. It applies to bodies by jurisdiction or by body, and builds on the glossaries of the regions around it. A meeting's glossary merges those of all its bodies. People's names aren't in it.
_Avoid_: jargon, dictionary, vocabulary, mishearings

**Glossary entry**:
One word or phrase in a glossary: its headword (the correct spelling), its meaning, its variants (other correct spellings) and how it has been misheard.
_Avoid_: term, word (that is a word of a transcript)

**Meeting source**:
Where a body's meetings are published, scanned for new ones: a YouTube channel or playlist, or an Alaska Legislature committee on akleg.gov. A body has at most one; bodies that share a YouTube channel each get a playlist on it.
_Avoid_: video source, feed, playlist, channel (unless it really is one)

**Site**:
A website meetings are published on, YouTube or akleg.gov, from which we get a recording's metadata and audio.
_Avoid_: platform, provider, host

**Recording**:
One item published on a site that may be a meeting: a YouTube video, or a meeting page on akleg.gov with an audio file and usually a video. Its audio is what we transcribe. It has an ID on its site, its recording ID: a YouTube video ID, or an akleg.gov meeting ID like `HRES 2018-09-10 14:00:00`. A meeting has exactly one.
_Avoid_: video (unless it is one), stream, clip, media, item, post, listing, site ref

### Meetings and transcripts

**Meeting**:
One gathering of one body, or of several in a joint meeting, with exactly one recording; the unit we transcribe, store, and display.
_Avoid_: session, hearing, event, recording, video

**Joint meeting**:
A meeting held by several bodies together, such as the Girdwood Board of Supervisors and the Girdwood Land Use Committee. It counts as a meeting of each of them, and none of them comes first.
_Avoid_: combined meeting, shared meeting, host body, co-host, primary body

**Meeting date**:
The local calendar day a meeting took place, in the meeting's own timezone. May be unknown.
_Avoid_: start time, timestamp

**Meeting time**:
The local wall-clock time a meeting gavelled in. Often unknown even when the meeting date is known.
_Avoid_: start time, timestamp

**Transcript**:
The ordered segments of one meeting: everything that was said, who said it, and when.
_Avoid_: minutes, captions, notes, transcription (that is the verb)

**Word**:
One recognized word and its onset; the smallest unit of a transcript.
_Avoid_: token, term

**Onset**:
How far into a meeting's audio a word begins, in seconds. Words have no end time.
_Avoid_: timestamp, start time

**Segment**:
A run of consecutive words spoken by one speaker.
The speaker's identity could be resolved
No limit on length.
If someone talks for 5 straight minutes, eg during a presentation, that is still one segment.
_Avoid_: utterance, turn, block, paragraph, line, clip

**Speaking time**:
The total duration of a speaker's segments within one meeting.
_Avoid_: talk time, airtime

### Speakers and people

A speaker is local to one meeting; a person is global across all meetings
(see [docs/speaker-identity.md](docs/speaker-identity.md)).

**Speaker**:
A distinct voice within one meeting, as shown in that meeting's transcript. Meaningless outside its meeting.
_Avoid_: participant, attendee, person (when you mean per-meeting)

**Speaker number**:
The per-meeting number diarization gives a cluster. Speaker 3 in one meeting has nothing to do with speaker 3 in another.
_Avoid_: speaker id, speaker index

**Person**:
A recurring individual, the same in every meeting they speak in, with exactly one voiceprint.
_Avoid_: speaker, user, member, voice, profile

**Known person**:
A person a human has established as a specific individual, and so has a slug.
_Avoid_: identified person, seeded speaker

**Name**:
A person's human-entered display name. Empty until someone enters it, and never used as a key.
_Avoid_: label, slug

**Named person**:
A person who has a name.
_Avoid_: identified person, known person

**Anonymous person**:
A person with no name yet: a voice recognized as recurring that nobody has put a name to.
_Avoid_: unknown person, unidentified person, unnamed speaker

**Placeholder name**:
The "Anonymous <Animal>" label shown for an anonymous speaker in one meeting. Never stored, and different in each meeting.
_Avoid_: fake name, alias

**Unattributed**:
Describes a segment with neither a person nor a speaker number, which may mix several voices. Shown as "Unknown".
_Avoid_: unlabeled, anonymous

**Bio**:
Free-form prose a human writes about a person: role, affiliation, tenure.
_Avoid_: description, about, title

**Attendance**:
For one person and one body, how many of the body's meetings the person spoke in, and over what dates. Counts speaking, not presence.
_Avoid_: membership, roster, participation

### Voice and recognition

**Voiceprint**:
A vector summarizing one voice. Each person has exactly one.
_Avoid_: voice embedding, speaker embedding, centroid, fingerprint

**Embedding**:
Any fixed-length vector produced by a model. Today only voice embeddings exist.
_Avoid_: vector (alone), feature

**Cluster**:
A group of diarization turns believed to share one voice. Each cluster becomes a speaker number.
_Avoid_: speaker (inside the pipeline), group

**Recognition**:
Linking an audio clip to a person.
Can use voiceprints or context clues like "Thank you ms smith", doesn't rely just on audio.
Two types: Partial and Full.
_Avoid_: identification, matching, labeling

**Partial Recognition**:
We recognize this speaker as "speaker 4" in this meeting, and possibly that
their name is "Bob", but we don't know the full identity of the person.

**Full Recognition**:
We recognize this speaker as an exact person, eg "Jennifer Wingard, the GBOS co-chair in 2026".

### Audio processing

**Span**:
A stretch of a meeting's audio, from start to end in seconds from the start of the file.
_Avoid_: range, interval, from/to.

**Transcription**:
The process of turning audio into a Transcript.
Relies on the larger context of the database, eg when identifying a speaker in audio,
it should be able to look up the voiceprints of the speakers already in the database.
_Avoid_: ASR, speech-to-text, captioning

**Speech run**:
A stretch of audio between silences, fed to the recognizer. Knows nothing about speakers.
_Avoid_: segment, chunk

**Diarization**:
The stage that splits audio into diarization turns and groups them into clusters by voice, knowing nothing about who anyone is.
_Avoid_: speaker detection, segmentation, identification

**Diarization turn**:
A span of time in which diarization heard one cluster speaking. Has a start, an end, and a speaker number, but no words.
_Avoid_: segment, turn (alone)

**Alignment**:
The stage that assigns each word to the diarization turn it overlaps most and groups consecutive same-speaker words into segments.
_Avoid_: merging, matching

### Test data and evaluation

**Test data**:
The checked-in jurisdictions, bodies, people, and golden meetings that seeding loads.
_Avoid_: fixtures, seed data, snapshot

**Golden meeting**:
A meeting in the test data: its metadata, golden transcript, and audio.
_Avoid_: test meeting, sample

**Golden transcript**:
A human-reviewed transcript used as ground truth for a meeting, stored as PSV.
_Avoid_: fixture, snapshot, expected output, reference

**Generated transcript**:
A transcript a test run produces for inspection. Never ground truth.
_Avoid_: golden, output

**PSV**:
The pipe-separated, one-word-per-line format of golden transcripts (see [the datasets README](packages/datasets/README.md#transcript-format)).
_Avoid_: CSV, TSV, transcript file

**Speaker label**:
The speaker of a golden transcript's segment, tagged with how much we know: unlabeled, a cluster, or a known person.
_Avoid_: speaker tag, speaker id

**Seeding**:
Loading test data into a database as established truth, including building each known person's voiceprint from their golden segments.
_Avoid_: importing, populating

**Dataset**:
A named selection of the test data that seeding loads, declared by a spec in `packages/datasets/specs/`, such as `bodies` (only jurisdictions and bodies) or `all` (every golden meeting, with placeholder voiceprints). `pnpm db up --data <name>` and `dbTest` take one.
_Avoid_: seed, fixture set, golden data, dev data

**WER**:
Word error rate: how far a pipeline transcript's words are from a golden transcript's, as a fraction of the golden transcript's word count.
_Avoid_: accuracy, error

### Meeting rules

**Rule**:
A requirement a meeting's data must meet, such as `split-sentence`. Each rule is a file in `packages/core/src/rules/`.
_Avoid_: check, checker, validator, lint

**Rule code**:
A rule's kebab-case name. It says what is wrong, such as `word-out-of-order`, and reads naturally after "allow".
_Avoid_: issue code, check name, rule id

**Body-specific rule**:
A rule only some bodies follow, such as Anchorage's `bill-number`. A body opts into each by its rule code; every other rule applies to every meeting.
_Avoid_: local rule, style rule

**Violation**:
An instance of a meeting breaking a rule, with a rule code and message. It may be blamed on a single word, a segment, a set of segments, a chapter, a set of chapters, etc. If so, it has the diagnostic info needed to fix it.
_Avoid_: check result, problem, error (that is a severity)

**Severity**:
How a rule's violations are reported; each rule gives a default. `error` means the data is wrong: a golden meeting with one fails the tests. `warning` means the data is probably wrong or breaks a convention, and wants a look.
_Avoid_: level

**Issue**:
A violation with its severity and its location: file and line in the test data.
_Avoid_: diagnostic, finding, problem

**Check**:
To run the rules over a meeting, as `pnpm datasets:check` does. Only a verb; what it runs are rules.
_Avoid_: lint, validate

**Fix**:
A rule's rewrite of a meeting that removes its violations where the data alone says what the right rewrite is, such as dropping a filler word. A violation whose fix depends on what someone meant or which of several plausible changes is right, such as two segments whose words interleave, is left for a person or agent. Only some rules have one.
_Avoid_: autofix, repair, correction
