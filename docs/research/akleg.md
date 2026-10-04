# Alaska Legislature meetings on akleg.gov

Notes for adding the Alaska Legislature as a meeting source next to YouTube:
where its meetings and recordings are listed, what the recordings are, how to
play them on our site, and how their timelines line up. The prototype source is
[`packages/akleg`](../../packages/akleg). Findings are from 2026-10-04; re-test
before relying on them.

## Meetings

A meeting's ID is its chamber (`H` or `S`), committee code, and scheduled
start in Alaska time: `HRES 2018-09-10 14:00:00` is House Resources at 2 PM.
Codes can hold `&` (`SL&C`, Senate Labor & Commerce), so IDs must be
URL-encoded. The meeting's page is
`https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00`.

A joint meeting has an ID in each chamber (`HRES` and `SRES` at the same time)
that share one recording. Recordings are named after whichever room or
committee recorded them, not after the ID: `HRES 2018-09-10 14:00:00` has
`sres_1400.mp3` and `jres_1400.m4v`.

The Legislature sits for two years, numbered from the 1st in 1959: the 30th
in 2017-2018, the 34th in 2025-2026.

## The BASIS API

The Legislature publishes a JSON API, BASIS, which its own app uses. Read it,
not the HTML pages: it is versioned, and it lists every recording of a
meeting, where a meeting page's player shows only the first. Its tester is at
<https://www.akleg.gov/apptester.html>. (The `BasisPublicServiceAPI.pdf` it
links to is broken.)

A request is a GET to `https://www.akleg.gov/publicservice/basis/<section>`
with:

- query parameters `session=<legislature>` (always required) and `json=true`
  (otherwise XML), and optionally `minifyresult=true`
- header `X-Alaska-Legislature-Basis-Version: 1.4`
- header `X-Alaska-Legislature-Basis-Query: <query>`, where a query is a
  section, `;`-separated filters, then `,`-separated sub-collections to
  include

Queries that work:

| Query                                              | Returns                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `committees;code=RES;chamber=H,meetings,media`     | The committee, with all its meetings that Legislature and their recordings |
| `meetings;date=09/10/2018;chamber=H,media`         | A chamber's meetings that day, with recordings                             |
| `meetings;startdate=09/01/2018;enddate=09/30/2018` | Meetings in a date range (no recordings)                                   |
| `meetings,media`                                   | Every meeting that Legislature (3,041 for the 30th; 3.6 MB, ~10 s)         |

Quirks:

- Errors come back as XML with HTTP 200, even with `json=true`:
  `<Basis><Error><Code>FormatException</Code>...`. `meetings;date=...,media`
  without a `chamber` filter gets one; so do unknown sub-collections
  (`,audio`, `,mediafiles`).
- `meetings;sponsor=RES` and `meetings;committee=RES` are silently ignored and
  return every meeting. Filter by committee with the `committees` section.
- `,meetings;media` (a `;` instead of `,`) returns meetings with empty
  `MediaFiles`.
- `X-Alaska-Query-Count` in the response gives the result count; a `HEAD`
  returns just that.

A meeting (the fields worth knowing):

```json
{
  "Chamber": "H",
  "MeetingSponsor": "RES",
  "MeetingTitle": "RESOURCES",
  "MeetingDate": "2018-09-10",
  "MeetingTime": "14:00:00",
  "Location": "Anch LIO AUDITORIUM",
  "MeetingCanceled": false,
  "HasAudio": true,
  "HasVideo": true,
  "Url": "http://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES 2018-09-10 14:00:00",
  "Id": 165508,
  "MediaFiles": [
    {
      "MediaType": "V",
      "StartTime": "/Date(1536617700000)/",
      "Duration": 11229833,
      "Url": "http://www.akleg.gov/video/\\2018\\20180910\\jres\\jres_1400.m4v"
    },
    {
      "MediaType": "A",
      "StartTime": "/Date(1536616835000)/",
      "Duration": 10746500,
      "Url": "http://www.akleg.gov/ftr/2018\\20180910\\sres\\sres_1400.mp3"
    }
  ]
}
```

- `Id` is shared by a joint meeting's two chambers. The ID we use is
  `Chamber + MeetingSponsor + " " + MeetingDate + " " + MeetingTime`.
- `MediaFiles` repeats `AudioFiles` and `VideoFiles` combined, and often lists
  a file more than once. Deduplicate by URL.
- Media URLs mix in backslashes and doubled slashes; replace `\` with `/`,
  collapse `//` in the path, and use https.
- `Duration` is in milliseconds and matches the file.
- **`StartTime` is unreliable; don't use it.** For `HRES 2018-09-10 14:00:00`
  it puts the video's start at 14:15:00, but the video actually started about
  38 s before the audio (14:00:35). For `HRES 2026-09-10 13:00:00` it puts the
  audio's start on 2026-09-23, 13 days after the meeting.

## Recordings

|         | Audio ("FTR", For The Record)                         | Video                                                                    |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Path    | `/ftr/<year>/<yyyymmdd>/<room>/<room>_<hhmm>[_n].mp3` | `/video/<year>/<yyyymmdd>/<room>/<room>_<hhmm>.m4v`                      |
| Format  | MP3, 24 kHz stereo, 64 kbps (~29 MB/hour)             | MP4 (`.m4v`): H.264 720p30 + AAC stereo, 360–950 kbps (~160–430 MB/hour) |
| Present | Every recorded meeting                                | Most; some older ones are audio-only                                     |

Neither file name follows from the meeting ID (`sres_1300_1.mp3`, start
minutes like `_1533` for a 15:30 meeting), so they must come from the API.

**Several audio files** on one meeting (about 1 in 50) are alternate
recordings of the same meeting, not consecutive parts. Seen so far: the same
file under two names (identical size), a second recorder started a few
minutes later (`hres_1300.mp3` 6,547 s and `hres_1304.mp3` 6,531 s), and a
joint meeting recorded in two rooms (`sfin_0947.mp3`, `ssta_0947.mp3`). The
prototype transcribes the longest.

Transcribing the MP3 gives everything the models need. The prototype decodes
it as it downloads, without ffmpeg (see the
[akleg README](../../packages/akleg/README.md)), and its output matches
ffmpeg's to a correlation of 0.9999999.

## Playing recordings on our site

Both files play in a plain `<video>`/`<audio>` element pointed at akleg.gov.
Checked on `jres_1400.m4v` (2018) and `jres_1300.m4v` (2026):

- **Codecs:** H.264 Main + AAC-LC in MP4, and MP3: every browser plays them.
- **Seeking:** the server answers byte ranges (`Accept-Ranges: bytes`), so
  seeking doesn't download the whole file (500 MB for 3 hours of video).
- **Start-up:** the MP4s have their index (`moov`) at the front, so playback
  starts before the download ends. But for a 3-hour meeting the index is
  5–10 MB, so expect a second or two before the first frame.
- **Hotlinking:** requests with another site's `Origin` and `Referer` get a
  normal 200. There's no `Cross-Origin-Resource-Policy` header and no referrer
  check. Our site sets no content security policy that would block them.
- **No CORS headers**, so a page can play the media but not read it: no
  `crossorigin` attribute, no Web Audio analysis, no drawing frames to a
  canvas.
- **Bandwidth is theirs.** akleg.gov is behind Cloudflare, but media comes back
  `cf-cache-status: DYNAMIC`, so every play and seek reaches the
  Legislature's own server. It's public-record media, but worth a courtesy
  note to them if traffic grows.

The site's player is built on YouTube's (`packages/web/src/lib/youtube.ts`:
load, play, pause, seek, playback rate, current time). Playing akleg.gov media
means a second implementation of that controller around a media element.

### Timelines

Transcript timestamps are seconds into the audio we transcribed: the MP3. The
video starts at a different moment and runs longer, so a transcript time
needs an offset to become a video time:

| Meeting                    | Audio    | Video    | video time − audio time |
| -------------------------- | -------- | -------- | ----------------------- |
| `HRES 2018-09-10 14:00:00` | 10,746 s | 11,230 s | +38.2 s                 |
| `HRES 2026-09-10 13:00:00` | 8,996 s  | 9,393 s  | +341.7 s                |

The offset differs per meeting and the API's start times are wrong (above),
so it has to be measured. Lining up the two loudness envelopes finds it
sharply: decode the first 30 minutes of each to 8 kHz mono, take the log
energy of every 100 ms, subtract the mean, and pick the lag (±25 minutes)
with the highest correlation. The measurements above were made with:

```sh
ffmpeg -t 1800 -i <mp4 url> -vn -ac 1 -ar 8000 -f s16le video.raw
ffmpeg -t 1800 -i <mp3 url> -ac 1 -ar 8000 -f s16le audio.raw
```

(ffmpeg reads only the first ~80 MB of the MP4 for that.) In both, the best
lag scored well clear of its neighbors. Pipeline code can't use ffmpeg; it
would need a WebAssembly AAC decoder for the MP4's audio. None comes in the
same family as `opus-decoder` and `mpg123-decoder`, so that's a dependency to
choose.

## Plan

1. **Store both URLs** on the meeting (the MP3 always; the MP4 when there is
   one), plus the meeting ID.
2. **Play the MP3 first**, in an `<audio>` element. It's on the transcript's
   timeline exactly, every recorded meeting has one, and it's a sixth of the size or less
   of the video. It shows no picture.
3. **Add video later**, with the offset measured at ingest as above and stored
   on the meeting. The alternative, transcribing the MP4's audio instead of
   the MP3 so the timelines match by construction, needs the same AAC decoder
   and still leaves audio-only meetings on the MP3.

Beyond the player, the database and pipeline assume YouTube:

- `video_sources` holds `youtube_id` with kind `channel` or `playlist`. An
  akleg.gov source is a committee (`HRES`); the Legislature number follows
  from the date, so `om available` can query the current Legislature (and the
  previous one, early in a new one).
- `meetings.youtube_id` and the generated `youtube_url` would need a
  source-neutral ID (`HRES 2018-09-10 14:00:00`) and media URL columns.
- `om ingest` and `om available` take a `YouTube` and would pick the provider
  by the body's source.
- The meeting's date and time come from its ID, so `resolveMeetingDateTime`
  finds them in the title the prototype builds (`House RESOURCES -
2018-09-10 14:00:00`) without reading the transcript.

## Not in the API

A meeting page also has, in its player's inline script, the log notes'
agenda markers ("Start", each bill or overview, "Adjourn") placed on the
audio's timeline in seconds, as `newA.title="<title>"` followed by
`else {newDiv.style.left=(100000*<seconds>/totalMediaTime) + '%';}`. They
could seed chapters. Scraping them is fragile, so it belongs in a best-effort
step that never fails an ingest. The page's "Minutes" tab has the log notes
as text, and some meetings have official transcripts.
