# Querying production's data with DuckDB

Every night, production's public data is copied into one DuckDB file:

```
$OBJECT_STORE_PUBLIC_URL/exports/open-minutes.duckdb
```

Use it to answer questions about real meetings, find examples, check how a
change would play out on real data, or pick meetings to work on. You don't need
Postgres, production credentials or a copy of the repo's database.

It's **read-only and up to a day old**. To change data, use the `pnpm db` /
`om` tooling and the agent tools in `packages/tools`, not this file. To get a
writable database, run `pnpm db up` (see
[../contributing/db.md](../contributing/db.md)).

## Setup

- **The DuckDB CLI**: `uvx --from duckdb-cli duckdb` (or
  `pipx install duckdb-cli`, or the Python package `duckdb`).
- **`OBJECT_STORE_PUBLIC_URL`**: the bucket's public base URL, e.g.
  `https://pub-<hash>.r2.dev`. If it's unset, ask the user for it. Never guess.
- **Network**: the bucket's host, plus `extensions.duckdb.org`. DuckDB
  downloads its `httpfs` extension the first time you read over HTTP. If
  either is blocked, say which host so the user can allow it.

## Download it, or query it in place

**Querying in place** reads only the parts of the file a query needs, using
HTTP range requests:

```sh
duckdb -c "ATTACH '$OBJECT_STORE_PUBLIC_URL/exports/open-minutes.duckdb' AS om (READ_ONLY);
           USE om; SELECT count(*) FROM meetings;"
```

This is fast for lookups by `id` or `meeting_id`, because each table is
sorted that way, so DuckDB skips row groups that can't match. A query that
reads every segment's `text` (a word search, say) downloads that whole column
each time.

**Downloading** is better when you'll run more than a few queries, or any
full-text scans:

```sh
curl -fsSo /tmp/open-minutes.duckdb "$OBJECT_STORE_PUBLIC_URL/exports/open-minutes.duckdb"
duckdb -readonly /tmp/open-minutes.duckdb
```

Check the export's age and schema version with `FROM export_info`.

## Tables

Mirrors the Postgres schema in `packages/db/src/schema.ts`, whose comments
explain each column. In short:

| Table                 | One row per                                 | Key columns                                                                                                           |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `jurisdictions`       | government (Municipality of Anchorage)      | `name`, `state`                                                                                                       |
| `bodies`              | body that meets (Anchorage Assembly)        | `jurisdiction_id`, `name`, `timezone`                                                                                 |
| `video_sources`       | YouTube channel or playlist a body posts to | `body_id`, `kind`, `url`                                                                                              |
| `meetings`            | meeting, i.e. one video                     | `body_id`, `title`, `date`, `time` (wall clock in the body's timezone; null = unknown), `youtube_id`, `duration_secs` |
| `segments`            | stretch of one speaker talking              | `meeting_id`, `person_id`, `speaker_number`, `text`, `start_secs`, `end_secs`, `words`                                |
| `people`              | person (voice) across meetings              | `name` (null = not yet identified), `slug`, `bio`                                                                     |
| `chapter_generations` | run that wrote a meeting's chapters         | `meeting_id`, `model` (`"human"` if hand-written), `reviewed_by_human`                                                |
| `chapters`            | table-of-contents entry of a meeting        | `meeting_id`, `start_secs`, `end_secs`, `title`, `summary`, `bullets`                                                 |
| `chapter_speakers`    | speaker in a chapter                        | `chapter_id`, `person_id`, `speaker_number`, `speaking_secs`                                                          |
| `export_info`         | (one row)                                   | `exported_at`, `latest_migration`                                                                                     |

Things that trip people up:

- **Times are `INTERVAL`s** from the start of the video. Use
  `epoch(start_secs)` for seconds as a number.
- **Speakers**: `person_id` links a voice across meetings, but that person
  may not be named yet (`people.name` is null). If `person_id` is null,
  `speaker_number` is a label local to that meeting ("speaker 3"). Both null
  means no speaker info.
- **`words`** is a JSON array of `{"text", "start"}` objects: the word-level
  timing that `text`, `start_secs` and `end_secs` are derived from.
- **Not included**: voice embeddings, and any table not listed above. The
  file is public, so tables are added to the export by hand, in
  `.github/scripts/export-duckdb.sh`.
- **No indexes**. Joins and filters are plain scans, which DuckDB is fast at.

## Example queries

Link to a moment on the site with `/meetings/<meeting id>?t=<seconds>`.

Where was "housing" mentioned, and by whom?

```sql
SELECT m.id AS meeting_id, m.date, b.name_short AS body,
       coalesce(p.name, 'speaker ' || s.speaker_number) AS speaker,
       epoch(s.start_secs)::int AS t, left(s.text, 200) AS text
FROM segments s
JOIN meetings m ON m.id = s.meeting_id
JOIN bodies b ON b.id = m.body_id
LEFT JOIN people p ON p.id = s.person_id
WHERE s.text ILIKE '%housing%'
ORDER BY m.date DESC NULLS LAST, s.start_secs
LIMIT 50;
```

A meeting's transcript:

```sql
SELECT epoch(start_secs)::int AS t, coalesce(p.name, 'speaker ' || speaker_number) AS speaker, text
FROM segments s LEFT JOIN people p ON p.id = s.person_id
WHERE meeting_id = 1
ORDER BY start_secs;
```

Who talks most, across all meetings?

```sql
SELECT p.name, count(DISTINCT s.meeting_id) AS meetings,
       round(sum(epoch(s.duration_secs)) / 3600, 1) AS hours
FROM segments s JOIN people p ON p.id = s.person_id
GROUP BY ALL ORDER BY hours DESC LIMIT 20;
```

Meetings that still need work: unidentified speakers, or no chapters.

```sql
SELECT m.id, m.title,
       count(*) FILTER (WHERE s.person_id IS NULL OR p.name IS NULL) AS unnamed_segments,
       NOT EXISTS (FROM chapters c WHERE c.meeting_id = m.id) AS no_chapters
FROM meetings m
JOIN segments s ON s.meeting_id = m.id
LEFT JOIN people p ON p.id = s.person_id
GROUP BY ALL ORDER BY unnamed_segments DESC;
```

## Keeping output small

Segment text is long, and a careless `SELECT *` can flood your context. So:

- Select only the columns you need, and never `words` unless you need timings.
- Truncate text with `left(text, 200)`, and always `LIMIT`.
- Use `duckdb -csv`, `-json` or `-line` for output that's easy to parse.
  `-line` prints one field per line, which suits a few wide rows.
- Count before you list: `SELECT count(*) …` first.

## How it's made

The `export-duckdb` workflow
([`.github/workflows/export-duckdb.yml`](../../.github/workflows/export-duckdb.yml))
runs nightly, or by hand with `gh workflow run export-duckdb.yml`. It runs
[`.github/scripts/export-duckdb.sh`](../../.github/scripts/export-duckdb.sh)
against production, attached read-only, and uploads the result over the
previous file.

The same script works on any Postgres database. For example, to export your
local dev database:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/open_minutes__main \
  .github/scripts/export-duckdb.sh /tmp/dev.duckdb
```
