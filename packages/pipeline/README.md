# @open-minutes/pipeline

The steps that find meetings, add them to the database, and turn their audio
into speaker-attributed transcripts. Each step is its own function, and the
agent tools in `@open-minutes/agents` expose each as its own tool. Nothing runs
one step after another: an agent (or a person, or a test) calls them in turn.

| Step                  | Function            | Reads                                                  | Writes                                          |
| --------------------- | ------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| `discover_meetings`   | `discoverMeetings`  | bodies' meeting sources, the database                  | nothing                                         |
| `add_meeting`         | `addMeeting`        | the meeting's site                                     | `meetings`, `meeting_bodies`                    |
| `download_audio`      | `downloadAudio`     | the meeting's site                                     | `audio.wav`                                     |
| `transcribe`          | `transcribe`        | `audio.wav`                                            | `transcription.json`                            |
| `clean_transcription` | `clean`             | `transcription.json`                                   | `cleaned.json`                                  |
| `diarize`             | `diarize`           | `audio.wav`                                            | `diarization.json`                              |
| `align_speakers`      | `align`             | `cleaned.json`, `diarization.json`                     | `segments.json`                                 |
| `embed_speakers`      | `embedSpeakers`     | `audio.wav`, `segments.json`                           | `embeddings.json`                               |
| `recognize_speakers`  | `recognizeSpeakers` | `embeddings.json`, people's voiceprints                | `recognition.json`                              |
| `save_transcript`     | `saveTranscript`    | `segments.json`, `embeddings.json`, `recognition.json` | `people`, `segments`, `meetings.transcribed_at` |

Files are in the meeting's **work directory**,
`data/meetings/<site>_<id>/` under this package (gitignored; an akleg.gov ID's
spaces and colons become `-`). A step whose input is missing refuses, naming
the step that writes it. A step run again replaces its output.

`transcribe`, `diarize` and `embed_speakers` run the models in
`@open-minutes/audio` locally (sherpa-onnx, downloading ONNX models on demand)
and are slow: tens of minutes for a long meeting. The rest take seconds.
`clean_transcription` strips disfluencies such as "um" and stutters (see
`@open-minutes/core/transcription`'s `clean.ts`); `transcription.json` stays
the recognizer's verbatim output, so a changed cleaning rule only needs
`clean_transcription` and the steps after it.

## Adding a meeting

Each body has at most one **meeting source** (`bodies.meeting_source`): a
YouTube channel or playlist, or an Alaska Legislature committee on akleg.gov.
`discoverMeetings` scans them for meetings not in the database, each body's
newest first. A meeting's ID on its site is a YouTube video ID or an akleg.gov
meeting ID (`HRES 2018-09-10 14:00:00`, spaces and all), and goes in
`meetings.site_kind` and `meetings.site_id`.

`addMeeting` takes that ID and the slugs of the bodies that held the meeting,
several for a joint meeting. It copies the title, description and duration
from the site, reads the date and time from the title if it states them, and
takes the first body's timezone. The meeting has no transcript yet:
`meetings.transcribed_at` is null, and readers don't see it until
`saveTranscript` sets it.

`saveTranscript` is all or nothing: in one transaction it creates an anonymous
person for each speaker recognition left unmatched, inserts the segments, and
sets `transcribed_at`. It refuses a meeting that already has a transcript.

To scan a new body, set its source, eg:

```sql
UPDATE bodies SET meeting_source = '{"type":"akleg_committee","committee":"HRES"}' WHERE id = 5;
-- or {"type":"youtube_channel","channel_id":"UC..."}
-- or {"type":"youtube_playlist","playlist_id":"PL..."}
```

## Meeting audio cache

`@open-minutes/pipeline/audio-cache` downloads a meeting's audio into the
per-machine cache (`~/.cache/open-minutes/meetings/<youtubeId>/`) and reads it
back. The audio tools in `@open-minutes/agents` use it to open a meeting; they
call the models in `@open-minutes/audio` directly.
