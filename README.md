# Open Minutes — Meeting Transcript Database

Open Minutes turns recorded local-government meetings into a searchable,
speaker-attributed transcript database.

## Why

Local boards, assemblies and councils make a lot of decisions in public
meetings, but the record is usually a multi-hour YouTube video plus terse
written minutes. Finding out _who said what, and when_ means scrubbing through
hours of video. Open Minutes downloads those recordings, transcribes them,
works out who is speaking (and recognizes the same person across meetings by
voice), and stores the result as structured data you can browse, search and
query.

## What data it covers

The data model is general: **jurisdictions** (a government, eg the Municipality
of Anchorage) contain **bodies** (a group that actually meets, eg the Girdwood
Board of Supervisors or the Anchorage Assembly), each with one or more YouTube
**video sources** (channels or playlists). **Meetings** belong to a body, and
each meeting's transcript is a sequence of **segments** (a run of words by one
speaker, with word-level timestamps). Segments are attributed to **people**,
who carry a voiceprint so they can be recognized in later meetings. See
[`packages/core/src/db/schema.ts`](packages/core/src/db/schema.ts).

Currently configured sources (the seed snapshot in
[`packages/pipeline/test-data/`](packages/pipeline/test-data/)):

| Jurisdiction                  | Body                                 | Source                                                                      |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Municipality of Anchorage, AK | Girdwood Board of Supervisors (GBOS) | [YouTube channel](https://www.youtube.com/channel/UCOUlNInprZEjhbpVPiJOlEA) |

The schema is designed to grow to other bodies, such as the Anchorage Assembly,
Planning & Zoning and the school board, which share the MOA channel; adding one
is a matter of adding rows to the seed data. The test data also includes three
hand-checked "golden" GBOS transcripts (March, May and June 2026) used to
measure transcription and speaker-recognition accuracy.

## Architecture

A [pnpm](https://pnpm.io) workspace with three packages:

- **[`packages/core`](packages/core)** (`@open-minutes/core`): shared domain
  code. The [Drizzle](https://orm.drizzle.team) schema and migrations, database
  connection/resolution, the YouTube boundary (via `yt-dlp`), transcript and
  timeline types, and voice-embedding helpers.
- **[`packages/pipeline`](packages/pipeline)** (`@open-minutes/pipeline`): the
  offline ingestion pipeline and the `om` CLI. It downloads audio, transcribes
  it locally with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (NeMo
  Parakeet ASR + Silero VAD), diarizes it into speaker turns (pyannote
  segmentation + CAM++ voice embeddings), aligns turns to words, matches
  voiceprints against known people, and writes the meeting to the database. No
  GPU or external API is needed; models are downloaded on first use. Also holds
  the database seeder. See the [pipeline README](packages/pipeline/README.md).
- **[`packages/web`](packages/web)** (`@open-minutes/web`): the public
  transcript browser, built with [SolidJS](https://www.solidjs.com) +
  [TanStack Start](https://tanstack.com/start) and Tailwind. Pages for meetings
  (transcript alongside the YouTube video), people, boards & councils, and
  transcript search. Editing (eg a meeting's date and time or a person's bio) is
  only enabled on the dev server; there is no auth yet.

**Database:** PostgreSQL with [pgvector](https://github.com/pgvector/pgvector)
(voiceprints are stored as vectors with an HNSW index). Locally it runs in
Docker via [`docker-compose.yml`](docker-compose.yml). For a hosted database
the web app supports [Neon](https://neon.tech), which it reaches over Neon's
HTTP driver (Workers can't open raw TCP sockets).

**Deploy target:** the web app deploys to
[Cloudflare Workers](https://workers.cloudflare.com) (worker `open-minutes`,
configured in [`packages/web/wrangler.jsonc`](packages/web/wrangler.jsonc)) via
`pnpm --filter @open-minutes/web run deploy`. The pipeline runs offline on a
developer machine and writes to the target database directly.

```
YouTube ──yt-dlp──▶ pipeline (om ingest) ──▶ Postgres + pgvector ◀── web (Cloudflare Workers)
                    transcribe / diarize /       (local Docker or Neon)
                    align / identify
```

## Quickstart

Prerequisites: Node 22+, [pnpm](https://pnpm.io) 10, Docker. To ingest
meetings you also need [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and
[`ffmpeg`](https://ffmpeg.org) on your `PATH`.

```sh
pnpm install
pnpm db:reset      # start local Postgres (Docker), migrate, and seed jurisdictions/bodies/sources
pnpm web:dev       # run the transcript browser against the local database
```

Ingest some meetings with the `om` CLI:

```sh
pnpm om available                  # video IDs on configured sources not yet ingested, newest first
pnpm om available | head -3 | pnpm om ingest   # transcribe + diarize + store the 3 newest
pnpm om status                     # list ingested meetings
```

### Choosing a database

Every entrypoint targets the `local` database (the docker-compose Postgres) by
default and needs no configuration. To target another, define
`DATABASE_URL_<NAME>` in a root `.env.local` (see
[`.env.example`](.env.example)) and pass `DB=<name>`, eg
`DB=prod pnpm db:migrate` or `DB=prod pnpm om status`. `DB` may also be a full
`postgres://` URL.

### Useful scripts

| Command                           | What it does                                         |
| --------------------------------- | ---------------------------------------------------- |
| `pnpm check`                      | typecheck, format check, lint and fast tests         |
| `pnpm test` / `pnpm test:all`     | fast tests / all tests including slow pipeline tests |
| `pnpm format`                     | format everything with Prettier                      |
| `pnpm db:migrate` / `db:generate` | apply / generate Drizzle migrations                  |
| `pnpm db:seed` / `db:nuke`        | seed the database / wipe and re-migrate it           |
| `pnpm db:studio`                  | open Drizzle Studio                                  |

## Using the data

- **Browse it:** run the web app and explore meetings, people, bodies and
  search.
- **Query it:** it's plain Postgres. Transcripts live in `segments` (with
  generated `text`, `start_secs` and `end_secs` columns derived from the
  word-level `words` JSON), joined to `meetings`, `bodies` and `people`. Eg:

  ```sql
  SELECT m.title, p.name, s.start_secs, s.text
  FROM segments s
  JOIN meetings m ON m.id = s.meeting_id
  LEFT JOIN people p ON p.id = s.person_id
  WHERE s.text ILIKE '%snow removal%'
  ORDER BY m.date, m.time, s.start_secs;
  ```

- **Script it:** the pipeline's API (`listIngested`, `listAvailable`,
  `ingestVideo` from `@open-minutes/pipeline/om`) and `om`'s JSON output
  (`om status --json`) are designed to be composed.

### Agent skill

Open Minutes ships an agent skill that teaches coding agents (eg Claude Code)
how to find and query meeting transcripts. Install it with:

```sh
npx skills add nickcrews/open-minutes
```

The skill lives in [`skills/`](skills/).

## Contributing and further reading

- [CONTRIBUTING.md](CONTRIBUTING.md): development workflow and conventions.
- [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md): glossary of domain terms
  (jurisdiction, body, meeting, segment, speaker, ...).
- [`adrs/`](adrs/): architecture decision records.
- [Pipeline README](packages/pipeline/README.md): details of the `om` CLI and
  ingestion stages.
