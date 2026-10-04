# @open-minutes/akleg

Where Open Minutes gets meetings published by the Alaska Legislature on
[akleg.gov](https://www.akleg.gov), a peer of
[`@open-minutes/youtube`](../youtube). It lists a committee's recorded
meetings, and implements `@open-minutes/core`'s `AudioProvider` for a
meeting: its metadata, and its audio as 16 kHz mono WAV. It knows nothing about
the database or what happens to the audio next.

**Status: prototype.** The pipeline doesn't use it yet; see "Not done" below.

## How akleg.gov publishes meetings

- A meeting's ID is its committee code and scheduled start, Alaska time:
  `HRES 2018-09-10 14:00:00` is House Resources at 2 PM. Its page is
  `/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00`.
- A committee's page, `/basis/Committee/Details/<legislature>?code=HRES`, lists
  its meetings for one two-year Legislature (the 30th sat in 2017-2018; see
  `legislatureOf`), each with an "Audio" or "Audio/Video" link when recorded.
- A meeting page's jPlayer script names an MP3 "FTR" (For The Record)
  recording, which every recorded meeting has, and often an MP4 video with its
  own, longer timeline. Neither file name follows from the ID
  (`sres_1300_1.mp3`), so both come from the page. The MP3s are 24 kHz stereo
  at 64 kbps (~29 MB per hour).
- The same script places the log notes' agenda markers ("Start", each bill,
  "Adjourn") on the audio's timeline in seconds. They go in the metadata's
  description, and could seed chapters.

## Audio

The MP3 is decoded as it downloads with libmpg123 compiled to WebAssembly
(`mpg123-decoder`), so, as for YouTube, no ffmpeg is needed and the output is
the same on every machine. MP3 can't be decoded straight to 16 kHz as Opus
can, so the channels are averaged and resampled with a polyphase windowed-sinc
filter (`Resampler` in `mp3.ts`). A 3-hour meeting takes about a minute and
160 MB. Its WAV matches ffmpeg's (`-ar 16000 -ac 1`) to a correlation of
0.9999999, about 1 ms apart (ffmpeg trims the encoder delay).

## Metadata

`getMetadata` maps a meeting onto `VideoMetadata`: the committee code stands in
for the channel ID, the page heading ("09/10/2018 02:00 PM House RESOURCES")
is the title, from which `resolveMeetingDateTime` reads the date and time, and
the meeting's date stands in for the upload date.

## Not done

- **The pipeline.** `om ingest` and `om available` take a `YouTube`, and the
  database is keyed on YouTube: `video_sources.youtube_id` with kind
  `channel`/`playlist`, and `meetings.youtube_id`/`youtube_url`. Ingesting from
  akleg.gov needs a source kind for an akleg committee (code + Legislature),
  a meeting column for a source-neutral ID and media URL, and the pipeline
  picking the provider by source.
- **The web player.** It embeds YouTube. akleg.gov media would need an
  `<audio>`/`<video>` player, and the video's timeline offset from the audio's
  (the page gives the video's start as a wall-clock time).
- **Video sources other than the MP3.** The audio is all transcription needs;
  the video is only useful for playback.
- **Akleg's own data.** Meeting pages carry log notes and, for some, official
  transcripts, and the Legislature has a
  [BASIS API](https://www.akleg.gov/publicservice/basis/) that may list
  meetings more robustly than scraping the committee page.
