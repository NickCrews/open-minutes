---
name: open-minutes
description: Query and cite Open Minutes data — speaker-attributed transcripts of local-government meetings (jurisdictions, bodies, meetings, segments, people) stored in Postgres. Use when asked what was said at a public meeting, who said something, what a board/assembly discussed, how often someone spoke, to find a quote and link to that moment in the meeting's YouTube video, or when writing SQL or drizzle queries against the Open Minutes database.
---

# Open Minutes data

Open Minutes turns YouTube videos of local-government meetings into
speaker-attributed, word-timestamped transcripts. All data lives in one
Postgres database (with pgvector). **There is no public HTTP/JSON API**: the web
app's server functions are internal, so query the database directly with SQL,
or with drizzle via `@open-minutes/core/db` when working inside the repo.

## The model in one breath

A **jurisdiction** (a government, e.g. Municipality of Anchorage) contains
**bodies** (things that meet, e.g. Girdwood Board of Supervisors). A body has
**meetings**, one per YouTube video. A meeting's transcript is a list of
**segments**: one speaker's contiguous run of **words**. A segment may belong to
a **person** — a voice recognized across meetings by its voiceprint.

```
jurisdictions 1─* bodies 1─* meetings 1─* segments *─0..1 people
                         1─* video_sources
```

Use these words (jurisdiction, body, meeting, segment, word, person, speaker)
exactly — they are the table names and the project's
[ubiquitous language](https://github.com/nickcrews/open-minutes/blob/main/UBIQUITOUS_LANGUAGE.md).
There are no "chapters", "agenda items", "votes" or "motions" tables — don't
look for them; answer those questions by searching segment text.

## Connecting

- Inside the repo: `getDb(target?)` from `@open-minutes/core/db` returns
  `{ db, client }`; call `client.end()` when done. `target` is a name
  (`"local"`, `"prod"`, resolved via `DATABASE_URL_<NAME>` in the root
  `.env.local`) or a full `postgres://` URL. Omitted, it uses `$DB`, then
  `$DATABASE_URL`, then `local`.
- Anywhere else: `psql "$DATABASE_URL"`. The zero-config local database
  (`docker compose up`, then `pnpm db:reset` to seed) is
  `postgres://postgres:postgres@localhost:5432/open_minutes`.
- Read, don't write. Never `INSERT`/`UPDATE`/`DELETE` unless the user asked
  for a data change, and never against `prod` without explicit confirmation.

## Rules that bite

1. **Times inside a meeting are seconds from the start of the video.**
   `segments.start_secs`/`end_secs`/`duration_secs` are Postgres `interval`s;
   use `extract(epoch from start_secs)` to get a number. Each word in
   `segments.words` is `{"text": "...", "start": <seconds>}` — onset only, no end.
   A segment's `end_secs` is an estimate (last word's onset + 0.5 s).
2. **Link to a moment** with the meeting's `youtube_url` plus
   `&t=<floor(seconds)>s`. `youtube_url` is `''` when there is no video.
3. **`meetings.start_time` is a UTC instant and is often NULL** (ingestion can't
   know when the gavel fell; a human fills it in). Render it in
   `bodies.timezone` (e.g. `America/Anchorage`), never in UTC or your local
   zone. `ORDER BY start_time DESC` puts NULLs first — add `NULLS LAST`.
4. **Speaker attribution has tiers** — check which one you have before claiming
   who said something:
   - `person_id` NULL, `speaker_number` NULL → no speaker info ("Unknown";
     may be several people).
   - `person_id` NULL, `speaker_number` set → a diarized voice, local to that
     meeting only. `speaker_number` 3 in one meeting ≠ 3 in another.
   - `person_id` set, `people.name` NULL → a recurring voice nobody has named
     yet (the UI shows "Anonymous <Animal>"). Say "an unidentified speaker".
   - `person_id` set, `people.name` set → a named person. `people.slug` (e.g.
     `margaret-tyler`) is the stable cross-meeting handle for known people.
5. **Voice matching is automatic and fallible.** Ingestion assigns a segment
   to the nearest stored voiceprint (cosine similarity ≥ 0.55) or creates a
   new unnamed person. Hedge attributions ("the transcript attributes this
   to…") and quote the exact text.
6. **Transcripts are machine-generated.** `segments.text` is the words joined
   with spaces, with ASR errors and imperfect punctuation. Search
   case-insensitively (`ILIKE`) and with short, distinctive phrases or
   several spellings; there is no full-text index.
7. **Skip heavy columns.** Never `SELECT *` from `people` (the
   `voice_embedding` vector is huge) and avoid `segments.words` unless you need
   word-level timing — `text` and `start_secs` usually suffice.
8. **Generated columns are read-only**: `segments.text`, `start_secs`,
   `end_secs`, `duration_secs`, `meetings.youtube_url`, `video_sources.url`
   derive from other columns. To change a transcript, change `words`.

## Citing an answer

For every claim, give: the speaker (per rule 4), the meeting title and
body, the local date if `start_time` is known, the quoted `text`, and a
YouTube link at the segment's `start_secs`. If the user runs the web app,
its pages are `/meetings/<id>`, `/people/<id>`, `/bodies/<id>` and
`/search?q=<text>`.

## Reference

- Every table and column, with types and meaning:
  [references/schema.md](references/schema.md)
- Copy-paste SQL and drizzle recipes (find what a person said, list a
  body's meetings, search a phrase, read a transcript, speaking time,
  deep links): [references/recipes.md](references/recipes.md)
