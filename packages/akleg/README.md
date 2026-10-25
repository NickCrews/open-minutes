# @open-minutes/akleg

Where Open Minutes gets meetings published by the Alaska Legislature on
[akleg.gov](https://www.akleg.gov), a peer of
[`@open-minutes/youtube`](../youtube). It lists a committee's recorded
meetings, and implements `@open-minutes/core`'s `AudioProvider` for a
meeting: its metadata, and its MP3 audio. `aklegSource({ committee:
"HRES" })` is a committee as a body's meeting source
(`{"type":"akleg_committee","committee":"HRES"}`): core's `RecordingLister`.

Meetings from a committee are stored with `site_kind` `akleg`. The site's player
can't play them yet. See [docs/research/akleg.md](../../docs/research/akleg.md)
for how akleg.gov publishes meetings, how to play them on our site, and
what's left to do.

## Metadata

Meetings and their recordings come from the Legislature's BASIS JSON API, not
from scraping its pages. Responses are checked with zod, so if the API
changes the fields used here, the call fails with an error instead of
returning wrong data.

`getMetadata` maps a meeting onto `RecordingMetadata`:

- **Channel ID:** the chamber and committee code (`HRES`).
- **Title:** `House RESOURCES - 2018-09-10 14:00:00`, from which
  `resolveMeetingDateTime` reads the date and time.
- **Upload date:** akleg.gov gives none, so the meeting's own date.

## Audio

The MP3 "FTR" recording is saved as akleg.gov serves it, streamed to disk.
[`@open-minutes/codecs`](../codecs/README.md) decodes it to 16 kHz WAV, with
no ffmpeg.

## Tests

- `index.test.ts` runs offline, on trimmed real API responses
  (`src/fixtures/`).
- `live.test.ts` runs against akleg.gov itself (~10 s), with every
  `pnpm test` and in CI. It checks known past meetings field by field, lists
  the current Legislature, and downloads and decodes a 7.5-minute meeting. A
  change to the API's format fails it with a zod error naming the field; so
  does akleg.gov being down.
