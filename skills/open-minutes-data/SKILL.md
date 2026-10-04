---
name: open-minutes-data
description: Answer questions about what was said at local government meetings in Alaska (Anchorage Assembly, Girdwood Board of Supervisors and others) using Open Minutes' transcripts. Use when someone asks what a board, assembly, council or official said or decided, who spoke about a topic, when something was discussed, or how often, or asks to find, quote or summarize part of a public meeting.
---

# Open Minutes data

[Open Minutes](https://open-minutes.nicholas-b-crews.workers.dev/) turns
recordings of local government meetings into searchable transcripts that show
who said what, and when. All of its data is public and in one file, which you
can query with SQL:

```
https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev/exports/open-minutes.duckdb
```

The file is rebuilt every night. It's free to download and needs no account or
key.

The person you're helping probably doesn't know or care about databases. Answer
in plain language, quote what was actually said, and link to the moment in the
video so they can check it themselves. Don't show them SQL unless they ask.

## Getting set up

You need DuckDB. Use whichever is easiest where you are:

- Python: `pip install duckdb`, then `duckdb.connect(path, read_only=True).sql("…")`
- The command-line tool: `pip install duckdb-cli` or `uvx --from duckdb-cli duckdb`

Download the file once, then query it as often as you like:

```sh
curl -fsSo open-minutes.duckdb https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev/exports/open-minutes.duckdb
duckdb -readonly open-minutes.duckdb -c "FROM export_info"
```

For just one or two quick lookups, you can query it in place without downloading
it. DuckDB fetches only the parts it needs, but it has to download its `httpfs`
extension (from `extensions.duckdb.org`) the first time:

```sql
ATTACH 'https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev/exports/open-minutes.duckdb' AS om (READ_ONLY);
USE om;
```

If a download is blocked, tell the person which website needs to be allowed:
`pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev` for the file, and
`extensions.duckdb.org` for querying in place.

## What's in it

| Table              | One row per                                                     | Useful columns                                                                |
| ------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `jurisdictions`    | government, e.g. the Municipality of Anchorage                  | `name`, `state`                                                               |
| `bodies`           | group that holds meetings, e.g. the Anchorage Assembly          | `jurisdiction_id`, `name`, `name_short`, `timezone`                           |
| `meetings`         | recorded meeting                                                | `body_id`, `title`, `date`, `time`, `url`, `duration_secs`                    |
| `segments`         | stretch of one person talking                                   | `meeting_id`, `person_id`, `speaker_number`, `text`, `start_secs`, `end_secs` |
| `people`           | person who speaks in meetings                                   | `name`, `bio`, `voice_embedding`                                              |
| `chapters`         | section of a meeting, usually one agenda item or public comment | `meeting_id`, `start_secs`, `end_secs`, `title`, `summary`, `bullets`         |
| `chapter_speakers` | person who spoke in a chapter                                   | `chapter_id`, `person_id`, `speaking_secs`                                    |
| `export_info`      | (one row) when the file was made                                | `exported_at`                                                                 |

Joins: `meetings.body_id → bodies.id`, `bodies.jurisdiction_id →
jurisdictions.id`, and `segments.meeting_id`/`chapters.meeting_id →
meetings.id`, `segments.person_id → people.id`.

There's also `chapter_generations`, which you'll rarely need.

Things to know:

- **Which meetings are covered** changes as more are added. Check with
  `SELECT b.name, count(*), min(date), max(date) FROM meetings m JOIN bodies b ON b.id = m.body_id GROUP BY ALL`
  rather than assuming.
- **Dates** are local to where the meeting was held. `time` is null when the
  start time isn't known, and `date` can be null too. Fall back on the
  meeting's `title`, which usually has the date in it.
- **Where a meeting was published**: `site_kind` is `youtube` or `akleg` (the
  Alaska Legislature's akleg.gov), `site_id` is its ID there (a YouTube video
  ID, or an akleg.gov meeting ID like `HRES 2018-09-10 14:00:00`), and `url`
  is its page there.
- **Times within a meeting** (`start_secs`, `end_secs`, `duration_secs`) are
  `INTERVAL`s from the start of its recording. `epoch(start_secs)` gives
  seconds as a number.
- **Speakers**: a segment's `person_id` points to a person, but many people
  don't have a `name` yet. If `person_id` is null, `speaker_number` tells
  apart the voices within that one meeting ("speaker 3"). Call an unnamed
  speaker "an unidentified speaker", never a guessed name.
- **Chapters** are summaries written by an AI model, except where
  `chapter_generations.reviewed_by_human` is true. They're the fastest way to
  see what a meeting covered and to find where a topic came up, but quote the
  transcript, not the summary.
- **`voice_embedding`** is a voiceprint: 192 numbers describing how a person
  sounds. Two people whose voiceprints have a cosine similarity of 0.55 or more
  are probably the same person (`list_cosine_similarity(a, b)`). Use it to
  check whether an unnamed voice is someone already named. Never print it.

## Linking to the source

Always give the person a way to check what you tell them:

- On Open Minutes, at that moment:
  `https://open-minutes.nicholas-b-crews.workers.dev/meetings/<meeting id>?t=<seconds>`
- Where it was published: the meeting's `url`. For a YouTube meeting, add
  `&t=<seconds>s` to it to start at that moment.
- A person's page, with everything they said:
  `https://open-minutes.nicholas-b-crews.workers.dev/people/<person id>`

## Be honest about the data's limits

Mention these when they matter to the answer:

- The transcripts are made by speech recognition, so they have mistakes,
  especially with names, places and quiet or overlapping speech. When a
  quote looks garbled, say so, and link to the video.
- Who's speaking is worked out automatically from people's voices, and it can
  be wrong.
- Only the meetings in the file are covered. "Nobody mentioned X" only means
  nobody did in these meetings, and the transcript might have misheard it.
- The file is up to a day old.

## Example queries

Where was "snow removal" mentioned, and by whom? Search for a few wordings,
because the transcript may phrase it differently than the person did:

```sql
SELECT m.id AS meeting_id, m.date, b.name_short AS body,
       coalesce(p.name, 'unidentified speaker') AS speaker,
       epoch(s.start_secs)::int AS t, m.url, left(s.text, 300) AS text
FROM segments s
JOIN meetings m ON m.id = s.meeting_id
JOIN bodies b ON b.id = m.body_id
LEFT JOIN people p ON p.id = s.person_id
WHERE s.text ILIKE '%snow removal%' OR s.text ILIKE '%snow plow%' OR s.text ILIKE '%plowing%'
ORDER BY m.date DESC NULLS LAST, s.start_secs
LIMIT 30;
```

What did a meeting cover?

```sql
SELECT epoch(start_secs)::int AS t, title, summary
FROM chapters WHERE meeting_id = 1 ORDER BY start_secs;
```

Read part of a meeting, e.g. the first five minutes of a chapter:

```sql
SELECT epoch(s.start_secs)::int AS t, coalesce(p.name, 'speaker ' || s.speaker_number) AS speaker, s.text
FROM segments s LEFT JOIN people p ON p.id = s.person_id
WHERE s.meeting_id = 1 AND s.start_secs BETWEEN INTERVAL 600 SECONDS AND INTERVAL 900 SECONDS
ORDER BY s.start_secs;
```

Find a person, and how much they've spoken:

```sql
SELECT p.id, p.name, p.bio, count(DISTINCT s.meeting_id) AS meetings,
       round(sum(epoch(s.duration_secs)) / 60) AS minutes
FROM people p JOIN segments s ON s.person_id = p.id
WHERE p.name ILIKE '%constant%'
GROUP BY ALL;
```

Is this unnamed voice someone we know?

```sql
SELECT other.id, other.name,
       round(list_cosine_similarity(me.voice_embedding, other.voice_embedding), 3) AS similarity
FROM people me, people other
WHERE me.id = 1 AND other.id != me.id AND other.name IS NOT NULL
ORDER BY similarity DESC LIMIT 5;
```

## Keeping results small

Transcripts are long, so a careless query can return far more text than you
can use.

- Count matches before listing them, and always use `LIMIT`.
- Select only the columns you need, and shorten text with `left(text, 300)`.
- Never select `voice_embedding`, or `segments.words` (per-word timings), to
  look at them.
- `duckdb -csv` or `-json` output is the easiest to read back.
