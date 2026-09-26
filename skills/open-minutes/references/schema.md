# Open Minutes schema

Source of truth: `packages/core/src/db/schema.ts` (drizzle). Every table has a
`serial` `id` primary key and a `created_at` timestamp (row creation, not when
anything happened in the world). Drizzle table exports are named
`<table>Table`, e.g. `meetingsTable`.

## jurisdictions

A government with boundaries (Municipality of Anchorage, City & Borough of
Juneau). It never meets itself — its bodies do.

| column       | type    | notes                       |
| ------------ | ------- | --------------------------- |
| `name`       | varchar | "Municipality of Anchorage" |
| `name_short` | varchar | "MOA"                       |
| `state`      | varchar | two-letter state, "AK"      |
| `postcode`   | varchar | nullable, often `''`        |

## bodies

A deliberative body that actually meets (Anchorage Assembly, Girdwood Board of
Supervisors). Meetings belong to bodies, not jurisdictions.

| column            | type    | notes                                                                       |
| ----------------- | ------- | --------------------------------------------------------------------------- |
| `jurisdiction_id` | int     | → `jurisdictions.id`                                                        |
| `name`            | varchar | "Girdwood Board of Supervisors"                                             |
| `name_short`      | varchar | "GBOS". Lowercased, this is the body **slug** (`gbos`) used by the `om` CLI |
| `homepage_url`    | varchar | nullable                                                                    |
| `timezone`        | varchar | IANA zone, "America/Anchorage". Render meeting times in this                |

## video_sources

Where a body's videos come from: a YouTube channel or playlist. Many-to-many
in spirit (one channel can carry several bodies), which is why it is its own
table. Rarely needed for questions about content.

| column       | type    | notes                                     |
| ------------ | ------- | ----------------------------------------- |
| `body_id`    | int     | → `bodies.id`                             |
| `kind`       | varchar | `'channel'` or `'playlist'`               |
| `youtube_id` | varchar | channel id (`UC…`) or playlist id (`PL…`) |
| `url`        | varchar | generated from `kind` + `youtube_id`      |

## meetings

One meeting = one YouTube video. A row exists only once ingestion fully
succeeded (there is no partial state).

| column          | type        | notes                                                                                  |
| --------------- | ----------- | -------------------------------------------------------------------------------------- |
| `body_id`       | int         | → `bodies.id`                                                                          |
| `youtube_id`    | varchar     | unique video id, e.g. `9HoIM5INxpI`; `''` if no video                                  |
| `youtube_url`   | varchar     | generated: `https://www.youtube.com/watch?v=<youtube_id>`, or `''`                     |
| `title`         | varchar     | the video title as published; often contains the date; may be `''`                     |
| `description`   | varchar     | the video description; sometimes holds the agenda                                      |
| `start_time`    | timestamptz | UTC instant the meeting gavelled in. **Often NULL** — set by a human, not by ingestion |
| `duration_secs` | interval    | video length; nullable                                                                 |

## people

A recurring voice, recognized across meetings by its voiceprint.

| column            | type        | notes                                                                                                       |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `slug`            | varchar     | unique, nullable. Stable handle for a known person (`margaret-tyler`). NULL for auto-created voices         |
| `name`            | varchar     | nullable. NULL = nobody has identified this voice yet. May include a role, "Mike Edgington (GBOS co-chair)" |
| `bio`             | varchar     | nullable free-form prose: role, affiliation, tenure                                                         |
| `voice_embedding` | vector(192) | the voiceprint; HNSW index. Exclude it from selects                                                         |

## segments

One speaker's contiguous run of words within a meeting — the unit of a
transcript.

| column           | type     | notes                                                                                       |
| ---------------- | -------- | ------------------------------------------------------------------------------------------- |
| `meeting_id`     | int      | → `meetings.id`                                                                             |
| `person_id`      | int      | → `people.id`, nullable                                                                     |
| `speaker_number` | int      | nullable; the diarizer's per-meeting cluster label. Meaningless across meetings             |
| `words`          | jsonb    | `[{"text": "Okay,", "start": 23.79}, …]` — `start` is seconds from video start. Never empty |
| `text`           | varchar  | generated: word texts joined with single spaces                                             |
| `start_secs`     | interval | generated: first word's `start`                                                             |
| `end_secs`       | interval | generated: last word's `start` + 0.5 s (an estimate)                                        |
| `duration_secs`  | interval | generated: `end_secs - start_secs`                                                          |

Order a transcript by `start_secs`, not `id`.

### Speaker tiers on a segment

| `person_id` | `speaker_number` | `people.name` | meaning                                               |
| ----------- | ---------------- | ------------- | ----------------------------------------------------- |
| NULL        | NULL             | —             | no speaker info at all ("Unknown")                    |
| NULL        | set              | —             | diarized voice, identity unknown, local to meeting    |
| set         | any              | NULL          | recurring voice, not yet named ("Anonymous <Animal>") |
| set         | any              | set           | named person                                          |

## SQL helper functions

Created by hand in migrations (drizzle-kit does not manage them), used by the
generated columns: `words_to_text(jsonb)`, `words_start_secs(jsonb)`,
`words_end_secs(jsonb)`.
