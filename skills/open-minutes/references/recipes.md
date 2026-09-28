# Open Minutes query recipes

SQL runs as-is in `psql`. Drizzle snippets assume you're inside the repo
(drizzle-orm `1.0.0-beta`, relational queries v2) with:

```ts
import { getDb } from "@open-minutes/core/db";
const { db, client } = getDb(); // or getDb("prod"), or getDb("postgres://…")
try {
  // …queries…
} finally {
  await client.end();
}
```

Helpers used below:

- **Seconds** from an interval: `extract(epoch from s.start_secs)`.
- **Deep link**: `m.youtube_url || '&t=' || floor(extract(epoch from s.start_secs))::int || 's'`
  (only when `m.youtube_url <> ''`).
- **Local meeting time**: `m.start_time AT TIME ZONE b.timezone` (a wall-clock
  `timestamp` in the body's zone; NULL if the start time is unknown). JS
  drivers turn that zoneless value into a `Date` that _looks_ like UTC; wrap
  it in `to_char(…, 'YYYY-MM-DD HH24:MI')` when the text is what you need.

## Orient: what's in this database?

```sql
SELECT j.name_short AS jurisdiction, b.id, b.name, b.name_short, b.timezone,
       count(m.id) AS meetings
FROM bodies b
JOIN jurisdictions j ON j.id = b.jurisdiction_id
LEFT JOIN meetings m ON m.body_id = b.id
GROUP BY j.id, b.id
ORDER BY b.name;
```

From the repo, `pnpm om status` (add `--json` for JSON lines) lists every
ingested meeting with its body slug, date and segment count.

## List meetings for a body

```sql
SELECT m.id, m.title, m.start_time AT TIME ZONE b.timezone AS local_start,
       m.duration_secs, m.youtube_url
FROM meetings m
JOIN bodies b ON b.id = m.body_id
WHERE b.name_short ILIKE 'gbos'          -- or b.id = …, or b.name ILIKE '%girdwood%'
ORDER BY m.start_time DESC NULLS LAST, m.id DESC;
```

Meetings with a NULL `start_time` may still have the date in `title`
("… Regular Meeting March 23, 2026").

```ts
const body = await db.query.bodiesTable.findFirst({
  where: { name_short: "GBOS" },
  with: { jurisdiction: true, meetings: { orderBy: { start_time: "desc" } } },
});
```

## Find a person

```sql
SELECT id, slug, name, bio
FROM people
WHERE name ILIKE '%wingard%' OR slug ILIKE '%wingard%';
```

Never `SELECT *` here: `voice_embedding` is a 192-dim vector.

## What did a person say? (optionally about a topic)

```sql
SELECT m.title, b.name_short AS body,
       m.start_time AT TIME ZONE b.timezone AS local_start,
       s.start_secs, s.text,
       CASE WHEN m.youtube_url <> '' THEN
         m.youtube_url || '&t=' || floor(extract(epoch FROM s.start_secs))::int || 's'
       END AS link
FROM segments s
JOIN meetings m ON m.id = s.meeting_id
JOIN bodies b ON b.id = m.body_id
WHERE s.person_id = 42
  AND s.text ILIKE '%snow removal%'      -- drop for everything they said
ORDER BY m.start_time DESC NULLS LAST, m.id DESC, s.start_secs;
```

```ts
const rows = await db.query.segmentsTable.findMany({
  where: { person_id: 42, text: { ilike: "%snow removal%" } },
  columns: { words: false },
  with: {
    meeting: {
      columns: { id: true, title: true, start_time: true, youtube_url: true },
      with: { body: { columns: { name_short: true, timezone: true } } },
    },
  },
  orderBy: { id: "desc" },
  limit: 100,
});
```

## Search every transcript for a phrase

```sql
SELECT m.id AS meeting_id, m.title, p.name AS speaker,
       s.person_id, s.speaker_number, s.start_secs, s.text
FROM segments s
JOIN meetings m ON m.id = s.meeting_id
LEFT JOIN people p ON p.id = s.person_id
WHERE s.text ILIKE '%short-term rental%'
ORDER BY s.id DESC
LIMIT 50;
```

ASR mangles proper nouns and hyphenation: also try `'%short term rental%'`,
`'%STR%'`, singular/plural, or a regex (`s.text ~* 'short.?term rentals?'`).
Segments break at speaker changes, so a phrase can straddle two segments —
search for a distinctive single word if a phrase comes up empty.

## Read a meeting's transcript

```sql
SELECT s.start_secs,
       coalesce(p.name,
                CASE WHEN s.person_id IS NOT NULL THEN 'anonymous person #' || s.person_id
                     WHEN s.speaker_number IS NOT NULL THEN 'speaker ' || s.speaker_number
                     ELSE 'unknown' END) AS speaker,
       s.text
FROM segments s
LEFT JOIN people p ON p.id = s.person_id
WHERE s.meeting_id = 7
ORDER BY s.start_secs;
```

A multi-hour meeting has thousands of segments. Page with `LIMIT/OFFSET`, or
filter to a window: `AND s.start_secs BETWEEN interval '1 hour' AND interval '1 hour 15 minutes'`.

```ts
const meeting = await db.query.meetingsTable.findFirst({
  where: { id: 7 },
  with: {
    body: { with: { jurisdiction: true } },
    segments: {
      columns: { words: false },
      with: { person: { columns: { id: true, name: true, slug: true } } },
      orderBy: { start_secs: "asc" },
    },
  },
});
```

## Jump to a moment in the video

Given a meeting and a time in the video (e.g. "1:02:30" = 3750 s):

```sql
SELECT s.start_secs, s.end_secs, s.text
FROM segments s
WHERE s.meeting_id = 7
  AND s.end_secs >= interval '3750 seconds'
ORDER BY s.start_secs
LIMIT 5;
```

For a word-precise link, find the word inside `words`:

```sql
SELECT (w->>'start')::float8 AS secs, w->>'text' AS word
FROM segments s, jsonb_array_elements(s.words) AS w
WHERE s.id = 1234 AND w->>'text' ILIKE 'budget%';
```

`timestampInSeconds("1:02:30")` and `formatTimestamp(3750)` in
`@open-minutes/core/timeline` convert between the two forms.

## Who spoke, and for how long, in a meeting

```sql
SELECT s.person_id, p.name, s.speaker_number,
       sum(s.duration_secs) AS speaking_time, count(*) AS segments
FROM segments s
LEFT JOIN people p ON p.id = s.person_id
WHERE s.meeting_id = 7
GROUP BY s.person_id, p.name, s.speaker_number
ORDER BY speaking_time DESC;
```

## Which meetings has a person spoken in?

```sql
SELECT b.name_short AS body, count(DISTINCT s.meeting_id) AS meetings,
       min(m.start_time) AS first, max(m.start_time) AS last
FROM segments s
JOIN meetings m ON m.id = s.meeting_id
JOIN bodies b ON b.id = m.body_id
WHERE s.person_id = 42
GROUP BY b.id
ORDER BY meetings DESC;
```

`first`/`last` are UTC instants; render them in `bodies.timezone`.

## Find anonymous people worth naming

```sql
SELECT p.id, count(DISTINCT s.meeting_id) AS meetings, sum(s.duration_secs) AS speaking_time
FROM people p
JOIN segments s ON s.person_id = p.id
WHERE p.name IS NULL
GROUP BY p.id
ORDER BY meetings DESC, speaking_time DESC
LIMIT 20;
```
