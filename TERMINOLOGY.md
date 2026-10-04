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

**Body slug**:
A body's short lowercased name, such as `gbos`, used to refer to it on the command line and in file paths.
_Avoid_: muni slug, body id, short name

**Meeting source**:
Where a body's meetings are published, scanned for new ones: a YouTube channel or playlist, or an Alaska Legislature committee on akleg.gov. A body has at most one; bodies that share a YouTube channel each get a playlist on it.
_Avoid_: video source, feed, playlist, channel (unless it really is one)

**Site**:
A website meetings are published on, YouTube or akleg.gov, from which we get a meeting's metadata and audio. A meeting has an ID on its site: a YouTube video ID, or an akleg.gov meeting ID like `HRES 2018-09-10 14:00:00`.
_Avoid_: platform, provider, host

### Meetings and transcripts

**Meeting**:
One gathering of one body, recorded as one video; the unit we ingest, store, and display.
_Avoid_: session, hearing, event, recording, video

**Meeting slug**:
A golden fixture meeting's stable, unique handle, such as `gbos-2026-03-23` (its fixture directory's name), that names it in every database; other meetings have none and go by their id.
_Avoid_: fixture name, meeting key

**Video**:
The YouTube recording of a meeting, from which its audio comes. An akleg.gov meeting has an audio recording, which is what we transcribe, and usually a video too.
_Avoid_: stream, clip, media

**Meeting date**:
The local calendar day a meeting took place, in its body's timezone. May be unknown.
_Avoid_: start time, timestamp

**Meeting time**:
The local wall-clock time a meeting gavelled in. Often unknown even when the meeting date is known.
_Avoid_: start time, timestamp

**Transcript**:
The ordered segments of one meeting: everything that was said, who said it, and when.
_Avoid_: minutes, captions, notes, transcription (for the artifact)

**Word**:
One recognized word and its onset; the smallest unit of a transcript.
_Avoid_: token, term

**Onset**:
How far into a meeting's audio a word begins, in seconds. Words have no end time.
_Avoid_: timestamp, start time

**Segment**:
A run of consecutive words spoken by one speaker.
_Avoid_: utterance, turn, block, paragraph, line, clip

**Speaking time**:
The total duration of a speaker's segments within one meeting.
_Avoid_: talk time, airtime

### Speakers and people

A speaker is local to one meeting; a person is global across all meetings
(see [ADR 0002](adrs/0002-two-tier-speaker-identity.md)).

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

**Slug**:
A known person's stable, unique handle, such as `margaret-tyler`; the key for their identity across meetings.
_Avoid_: name, id, handle

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
Linking a speaker to the person whose voiceprint is nearest, or creating a new anonymous person when none is close enough.
_Avoid_: identification, matching, labeling

### Pipeline

**Ingestion**:
Running one meeting's recording through transcription, diarization, alignment, and recognition, then storing the meeting and its segments all at once.
_Avoid_: import, processing, scraping, sync

**Available meeting**:
A meeting on a body's meeting source that hasn't been ingested yet.
_Avoid_: available video, new video, pending video, backlog

**Transcription**:
The stage that turns audio into words with onsets. The process, not the artifact; that's the transcript.
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

**Work directory**:
A meeting's cache of stage outputs (audio, transcription, diarization) kept between pipeline runs.
_Avoid_: cache dir, temp dir

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
The pipe-separated, one-word-per-line format of golden transcripts (see [ADR 0001](adrs/0001-psv-golden-transcript-format.md)).
_Avoid_: CSV, TSV, transcript file

**Speaker label**:
The speaker of a golden transcript's segment, tagged with how much we know: unlabeled, a cluster, or a known person.
_Avoid_: speaker tag, speaker id

**Seeding**:
Loading test data into a database as established truth, including building each known person's voiceprint from their golden segments.
_Avoid_: importing, populating

**WER**:
Word error rate: how far a pipeline transcript's words are from a golden transcript's, as a fraction of the golden transcript's word count.
_Avoid_: accuracy, error
