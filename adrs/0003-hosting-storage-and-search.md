# ADR 0003: Hosting, storage and search architecture

Date: 2026-09-26
Status: Proposed

## Context

Hosting should cost as close to nothing as possible. At the same time, people and
agents want fast search over every transcript: keyword (BM25) for sure, and
probably semantic too ("what was said about the Girdwood housing plan", "show me
everything Mike Edgington said"). This ADR looks at the current architecture
against those goals, asks whether blob storage alone could replace the database,
and picks a direction.

### What we run today

- **Web:** TanStack Start (Solid) SSR on Cloudflare Workers
  (`packages/web/wrangler.jsonc`). It is read-only in production.
  `permissions.ts` makes every edit endpoint throw outside dev.
- **Database:** Postgres + pgvector, on Neon in prod (the web reaches it over
  Neon's SQL-over-HTTP driver, `packages/web/src/server/db.ts`) and in
  docker-compose locally. The schema is small and relational: jurisdictions →
  bodies → meetings → segments ← people.
- **Ingestion:** an offline CLI (`om ingest`) on a dev machine. It runs
  transcription, diarization, alignment and embedding locally, then commits each
  meeting in one transaction. `identify.ts` uses a pgvector cosine search to match
  voiceprints to `people`.
- **Media:** not stored. The page embeds the YouTube player and seeks it by
  timestamp.
- **Search:** `ILIKE '%q%'` over `segments.text` (`features/search/index.ts`).
  That means a sequential scan, no ranking and no stemming. It is the weakest
  part of the stack.

### How big the data is

Measured from the three golden meetings (GBOS, 2.4–2.8 h each):

| Per meeting               | Size                      |
| ------------------------- | ------------------------- |
| Words                     | ~25k                      |
| Word-level JSON (`words`) | ~750 KB raw, ~140 KB gzip |
| Plain text                | ~125 KB                   |
| Audio as 24 kbps Opus     | ~28 MB                    |
| Video, 720p               | ~2–3 GB                   |

In Postgres, a meeting comes to roughly **1–1.5 MB** all in. That covers
compressed `words` jsonb, the derived text, a tsvector with its index, and around
200 passage embeddings (halfvec, 384–768 dims) with an HNSW index. So:

- 100 meetings ≈ 150 MB, which fits any free tier.
- 1,000 meetings ≈ 1.5 GB.
- 10,000 meetings (every body in Alaska for years) ≈ 15 GB.

**The text corpus is small.** Even at 10k meetings it is a single-digit-GB
database. Only media is big. That fact drives most of the decisions below.

## Question 1: Could we use only blob storage?

That would mean publishing each meeting as a static JSON file to R2 or S3, plus a
prebuilt search index, with no database at all.

**What works:**

- Meeting pages. A meeting is an immutable document once ingested. `GET
/meetings/:id` could be one gzipped JSON file on a CDN, with no compute behind
  it.
- Browser-side keyword search. Pagefind, or SQLite-over-HTTP-range-requests,
  fetches only the index shards a query needs. It costs $0 and is fast for a
  corpus in the hundreds of meetings.
- Bulk export for agents. Parquet or JSONL dumps in R2 are the cheapest way to
  serve "give me everything".

**What breaks:**

1. **Ingestion needs a database already.** `identify.ts` does a nearest-neighbour
   search over every known voiceprint on each ingest. It creates people, and a
   meeting's commit is all-or-nothing. Blob storage has no transactions and no
   index. We would end up rebuilding a database in the CLI, out of files.
2. **Edits are cross-cutting.** Naming a person, or reassigning a speaker, touches
   every meeting they appear in. With blobs, every such edit means re-rendering
   and re-uploading N files and rebuilding the search index. With a database it
   is one `UPDATE`.
3. **Agents need a server-side query API.** A browser-shard index works for a
   person typing in a search box. It does not work for an agent calling
   `search(q, person, body, date_range)` over HTTP or MCP. Once we need that
   endpoint, we need a queryable index behind it.
4. **Semantic search needs the query embedded at request time.** That means
   compute and a vector index. Brute force over static vector files works up to a
   few hundred thousand vectors in a browser, but it is heavy to ship.
5. **Every transactional feature in #34 needs a real OLTP store** (see
   Question 5).

**Verdict:** blob storage is the right home for **media, bulk exports, and
optionally a CDN-cached copy of each rendered meeting**. It is the wrong system of
record. Keep the database, and use blobs next to it for bulky, immutable data.

## Question 2: Which database?

These are the realistic options, all serverless and all near-$0 at our size.
Prices were checked in September 2026; confirm them before committing.

| Option                               | Idle cost                                                                | At ~1.5 GB (1k meetings)                                  | BM25                                                                                                                                                           | Vectors                                                                                                        | Transactions                              | Fit with current code                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Neon Postgres** (current)          | $0: scales to zero after 5 min idle. Free tier is 0.5 GB and 100 CU-h/mo | ~$0.50/mo storage, plus $0.106/CU-h while awake on Launch | Native `tsvector` (ranked, but not true BM25). True BM25 via the `lakebase_text` extension. **ParadeDB `pg_search` is being removed from Neon on 2026-09-21.** | pgvector (in use today), or `lakebase_vector`                                                                  | Full, interactive                         | No changes needed                                                                                                          |
| **Supabase Postgres**                | Free tier pauses after a week idle. Pro is a flat $25/mo                 | $25/mo                                                    | `tsvector`. Some BM25 extensions.                                                                                                                              | pgvector                                                                                                       | Full                                      | Driver swap only                                                                                                           |
| **Cloudflare D1** (SQLite)           | $0 on free tier. On Workers Paid ($5/mo) the first 5 GB are included.    | ~$0 beyond the $5 plan                                    | **FTS5 with built-in `bm25()`**: real BM25, free                                                                                                               | None built in. Use **Vectorize**, a separate service (free tier is 5M stored dims; queries $0.01 per 1M dims). | Batches only; no interactive transactions | Full rewrite: schema, migrations, generated columns, pgvector identify, and the CLI would have to write over D1's HTTP API |
| **Turso / libSQL**                   | Generous free tier                                                       | ~$0–5/mo                                                  | FTS5                                                                                                                                                           | Native vector columns                                                                                          | Yes                                       | Rewrite, same as D1                                                                                                        |
| **Self-hosted Postgres on a $5 VPS** | $5/mo                                                                    | $5/mo                                                     | Any extension (ParadeDB, VectorChord-bm25, …)                                                                                                                  | pgvector                                                                                                       | Full                                      | No changes needed; you run ops and backups                                                                                 |
| **Blobs only** (Q1)                  | ~$0                                                                      | ~$0                                                       | Pagefind, client-side                                                                                                                                          | Client-side brute force                                                                                        | None                                      | Rewrite; loses the identify step                                                                                           |

### Recommendation: stay on Neon Postgres, and make caching do the cost-cutting

Price differences between the managed options are cents to a few dollars a month
at our scale. What actually drives cost is **how many requests wake the database
up**. A public corpus of finished meetings changes only when we ingest, so:

1. **Cache everything at the edge.** Put `Cache-Control: public, s-maxage=…,
stale-while-revalidate` on meeting, person, body and search GETs, and purge
   (or bump a version key) on ingest. Most page views never reach Neon. The
   compute scales to zero and the bill is storage plus a few CU-hours.
2. **One database does relational, BM25 and vectors.** "Everything person Y said
   about topic X in body Z since 2025" is then a single SQL query: a `JOIN` plus a
   `WHERE` plus hybrid ranking. D1 + Vectorize splits that across two systems, and
   the app has to fuse and filter results, with eventual consistency between them.
   Filtering a vector search by person or date is a first-class `WHERE` in pgvector,
   but a metadata-index feature in Vectorize.
3. **No rewrite.** Moving to D1 would cost weeks of work (generated columns,
   intervals, jsonb functions, pgvector identify, drizzle `pg-core`, interactive
   transactions in ingest) to save roughly $0–5 a month.

**When to reconsider:**

- If Neon's free tier or compute bills become a real line item even with caching,
  **D1 + Vectorize** is the cheapest serious alternative, because we already
  deploy to Workers.
- If we want full control over extensions, a **VPS Postgres** is the flat-rate
  fallback.

Keep the data layer behind `features/*` functions, as it is today, so a swap stays
contained.

### A lever to hold in reserve: move `words` out of the database

Word-level jsonb is about 80% of database bytes. Only the meeting page's synced
transcript needs it. Search needs segment text and passages. If the database
outgrows a free or cheap tier, we could publish `words` per meeting as a gzipped
JSON blob in R2 (~140 KB) and keep only segment and passage text in Postgres. That
shrinks the database 4–5× and turns the transcript payload into a CDN hit.

This is not worth doing yet: the generated `text`/`start_secs`/`end_secs` columns
depend on `words`, and one source of truth is worth more than 1 GB.

## Question 3: How should search work?

### The unit of search is a passage, not a segment

A segment is one speaker turn, which can run for minutes. A hit should deep-link
to the right _second_, and an embedding of a 5-minute ramble is mush. So add a
derived `passages` table:

```
passages(id, meeting_id, segment_id, person_id, body_id, meeting_date,
         start_secs, end_secs, text,
         tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
         embedding halfvec(N))
```

- Each passage is roughly 30–60 s, or ~100–200 words. It is cut from one segment
  on sentence or word boundaries with a small overlap, and never crosses a speaker
  change.
- It is denormalized (`person_id`, `body_id`, `meeting_date`) so filtered queries
  need no joins.
- It is derived at ingest from segments. It can be rebuilt at any time
  (`om reindex`) when we change chunking or the embedding model.

### Query types, and what each one needs

| Query                                                             | Mechanism                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Everything person Y said"                                        | **Not a search problem.** It is a filter: `segments WHERE person_id = ? ORDER BY meeting start, start_secs`, with an index on `(person_id, meeting_id)`. It needs pagination, not ranking. |
| Exact phrase or keyword ("Resolution 2026-14", "Alyeska")         | BM25 over `passages.tsv`, with a phrase query when the term is quoted                                                                                                                      |
| Topic ("what was said about housing density")                     | Hybrid: BM25 plus vector kNN, fused with Reciprocal Rank Fusion (RRF) in one SQL CTE                                                                                                       |
| Scoped versions of any of the above (by person, body, date range) | `WHERE` on the denormalized passage columns, applied inside both retrievers                                                                                                                |
| "Summarize the debate on X"                                       | Retrieval as above, then an LLM (the RAG layer). This is an agent or product feature on top of search, not part of the index.                                                              |

### Implementation stages

1. **Now, at $0:** a `tsvector` generated column plus a GIN index on passages
   (or on segments, as a stopgap). Rank with `ts_rank_cd` and use
   `websearch_to_tsquery` for query parsing. Snippets come from `ts_headline`.
   This replaces `ILIKE` and is already far better.
2. **True BM25:** on Neon, `lakebase_text` (a `lakebase_bm25` index over the same
   tsvector). Do **not** adopt `pg_search` there, since it is being removed. If we
   move off Neon, ParadeDB or VectorChord-bm25 on self-hosted Postgres, or FTS5
   `bm25()` on D1, fill the same slot.
3. **Semantic:** pgvector `halfvec` plus an HNSW index on passages. Two
   constraints matter:
   - **The same model must embed both documents and queries.** Queries are
     embedded at request time inside the Worker. The cheapest way is Workers AI
     (for example, a `bge` model). Embed documents at ingest with the _same_
     model, either by calling the same API or by running the identical open
     weights through ONNX locally, as the pipeline already does for audio.
     Record the model name on each row so a model change triggers a re-embed.
   - Start small: 384 dims, then quantize (halfvec now, binary or int8 with
     rescoring later). 1k meetings × ~200 passages × 384 dims in halfvec is
     roughly 150 MB, which is trivial.
4. **Chapters (#25) as a second semantic tier.** Chapter titles and summaries are
   better topic targets than raw speech. Index them in the same way, and let a
   topic query hit chapters first and then drill into passages.

### Agents

Expose search as a read-only HTTP API from the same Worker, and wrap it as an MCP
server. Suggested tools:

- `search(q, mode=hybrid|keyword|semantic, person?, body?, from?, to?)`
- `get_meeting(id, from_secs?, to_secs?)`
- `get_person(id|slug)`
- `list_meetings(body?, from?, to?)`

Put the same edge cache in front of it. For agents that want everything, publish
nightly Parquet or JSONL snapshots to R2. It is effectively free, and it keeps bulk
consumers off the database.

## Question 4: Audio and video

- **Video: keep using YouTube as the host and player.** Hosting video ourselves is
  the only thing here that would cost real money: ~2.5 GB per meeting is ~2.5 TB
  per 1k meetings, which is ~$25–40/mo even on cold storage.
- **Audio: store a 24–32 kbps Opus copy of each meeting in R2.** That is ~28 MB
  per meeting, or ~28 GB per 1k meetings, which is ~$0.40/mo on R2 Standard. The
  first 10 GB are free and there are no egress fees. It unlocks four things:
  - re-running the pipeline without going back to YouTube;
  - a working page when YouTube removes or privatizes a video;
  - "play just this clip" with no YouTube dependency (#14, #15);
  - voiceprint recomputation.

  Ingestion already has `audio.wav` locally. Uploading an Opus encode is one more
  cached stage.

- **Original video archive (optional):** only if preservation becomes a goal. Use
  R2 Infrequent Access ($0.01/GB-mo) or Backblaze B2, written once and rarely
  read. Put a key on `meetings` (`audio_key`, `video_archive_key`) rather than
  URLs, so buckets and CDNs can change.

## Question 5: What changes if we add transactional features

The brainstorm is tracked in #34. In summary, the moment users can log in,
edit, subscribe or upload:

- **Postgres becomes more clearly the right choice.** It gives interactive
  transactions, row-level security and constraints for moderation workflows. D1
  handles light OLTP (single writer per database), but concurrent community edits
  plus an audit trail are Postgres's home turf.
- **Split public corpus from private user data.** The corpus stays public,
  cacheable and exportable. Accounts, subscriptions, API keys and drafts live in
  their own schema (or database) and are never cached at the edge. Edits to the
  corpus go through a moderated `proposed_edits` → apply path. That keeps cache
  invalidation coarse and rare, which keeps compute near zero.
- **Background work appears:** alert fan-out after ingest, email, re-indexing,
  and user-requested ingestion. Use Cloudflare Queues and Cron Triggers for light
  work. Heavy transcription stays on a separate worker box that pulls jobs from a
  queue, not on Workers.
- **Scale-to-zero stops working** as soon as there is a steady authenticated
  write load, because an always-awake 0.25 CU is ~$19/mo on Neon Launch. That is
  still cheap, and it is the point where flat-rate (VPS or Supabase Pro) starts to
  look competitive.
- **LLM features (RAG answers, summaries on demand) are the real cost risk,** far
  more than storage or database. They need per-user quotas and rate limits, which
  is itself a reason for accounts.

## Decision

1. Keep Postgres on Neon as the system of record. Do not move to blobs-only or D1
   for now.
2. Add edge caching for all public GETs, with purge on ingest. This is the main
   cost lever.
3. Replace `ILIKE` search:
   - `passages` table with a tsvector and GIN index now;
   - `lakebase_text` BM25 when ranking quality needs it;
   - pgvector semantic search plus RRF hybrid after that.
4. Store an Opus audio copy per meeting in R2. Keep YouTube for video.
5. Expose a read-only search API and MCP server for agents, plus periodic bulk
   exports to R2.
6. Revisit the database choice only if caching fails to keep compute near zero,
   or when transactional features land (#34).
