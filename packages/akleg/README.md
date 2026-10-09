# @open-minutes/akleg

Where Open Minutes gets meetings published by the Alaska Legislature on
[akleg.gov](https://www.akleg.gov), a peer of
[`@open-minutes/youtube`](../youtube). It lists a committee's recorded
meetings, and implements `@open-minutes/core`'s `AudioProvider` for a
meeting: its metadata, and its audio as 16 kHz mono WAV. It knows nothing about
the database or what happens to the audio next. `aklegSource({ committee:
"HRES" })` is a committee as a body's meeting source
(`{"type":"akleg_committee","committee":"HRES"}`): core's `VideoLister`,
which discovery takes.

The pipeline's `discover_meetings`, `add_meeting` and `download_audio` steps
use it for bodies whose meeting source is a committee; their meetings are
stored with `site_kind` `akleg`. The site's player
can't play them yet. See [docs/research/akleg.md](../../docs/research/akleg.md)
for how akleg.gov publishes meetings, how to play them on our site, and
what's left to do.

## Metadata

Meetings and their recordings come from the Legislature's BASIS JSON API, not
from scraping its pages. Responses are checked with zod, so if the API
changes the fields used here, the call fails with an error instead of
returning wrong data.

`getMetadata` maps a meeting onto `VideoMetadata`:

- **Channel ID:** the chamber and committee code (`HRES`).
- **Title:** `House RESOURCES - 2018-09-10 14:00:00`, from which
  `parseDateFromTitle` reads the date and time.
- **Upload date:** akleg.gov gives none, so the meeting's own date.

## Audio

The MP3 "FTR" recording is decoded as it downloads with libmpg123 compiled to
WebAssembly (`mpg123-decoder`), so, as for YouTube, no ffmpeg is needed and the
output is the same on every machine. MP3 can't be decoded straight to 16 kHz
as Opus can, so the channels are averaged and resampled with a polyphase
windowed-sinc filter (`Resampler` in `mp3.ts`). A 3-hour meeting takes about a
minute and 160 MB of memory. Its WAV matches ffmpeg's (`-ar 16000 -ac 1`) to a
correlation of 0.9999999, about 1 ms apart (ffmpeg trims the encoder delay).

## Tests

- `index.test.ts` and `mp3.test.ts` run offline, on trimmed real API responses
  (`src/fixtures/`) and a generated MP3.
- `live.test.ts` runs against akleg.gov itself (~10 s), with every
  `pnpm test` and in CI. It checks known past meetings field by field, lists
  the current Legislature, and downloads and decodes a 7.5-minute meeting. A
  change to the API's format fails it with a zod error naming the field; so
  does akleg.gov being down.
