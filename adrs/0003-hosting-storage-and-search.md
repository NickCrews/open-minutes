# ADR 0003: Hosting, storage and search architecture

Date: 2026-09-26
Status: Proposed

## Context

Open Minutes is civic infrastructure. It should be free to use, need no account
to read, and cost as close to nothing as possible to host, so it can run for
years on a shoestring (or outlive its maintainers). At the same time, people and
agents want fast search over every transcript and every meeting document: keyword
(BM25) for sure, and probably semantic too ("what was said about the Girdwood
housing plan", "show me everything Mike Edgington said").

This ADR looks at the current architecture against those goals, asks whether
blob storage alone could replace the database, and picks a direction.

### Principles

1. **Static first.** Published data is files sitting on a CDN: pages, transcripts,
   documents, audio and bulk downloads. Anything that can be computed once at
   publish time is not computed per request.
2. **We pay for costs that grow with meetings, never for costs that grow with
   users.** Transcription, OCR, embeddings and chapter summaries run once per
   meeting, on our pipeline, and are bounded by how many meetings exist. The only
   per-request compute we host is search, and that must be cheap enough to give
   away.
3. **Users bring the AI.** "Ask the minutes" and "summarize this debate" run in
   the user's own Claude, Gemini or ChatGPT, or in Google's search results.
   Our job is to make the data trivially readable by those tools, not to host an
   LLM. No LLM calls on our bill means no accounts, quotas or billing.
4. **No account to read, ever.** Abuse protection is anonymous: edge caching,
   per-IP rate limits, and free tiers that fail closed (an outage rather than a
   surprise bill).

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
- **Media and documents:** none are stored. The page embeds the YouTube player
  and seeks it by timestamp. Agendas, packets and bills aren't ingested yet.
- **Search:** `ILIKE '%q%'` over `segments.text` (`features/search/index.ts`).
  That means a sequential scan, no ranking and no stemming. It is the weakest
  part of the stack.

### How big the data is

Transcript sizes are measured from the three golden meetings (GBOS, 2.4–2.8 h
each). Document sizes are estimates.

| Per meeting                               | Size                       |
| ----------------------------------------- | -------------------------- |
| Words                                     | ~25k                       |
| Word-level JSON (`words`)                 | ~750 KB raw, ~140 KB gzip  |
| Plain text                                | ~125 KB                    |
| Audio as 24 kbps Opus                     | ~28 MB                     |
| Documents (agenda, packet, bills), as PDF | ~5–50 MB, often 100+ pages |
| Extracted document text                   | ~1–3 KB per page           |
| Video, 720p                               | ~2–3 GB                    |

In Postgres, a meeting comes to roughly **1–1.5 MB** all in. That covers
compressed `words` jsonb, the derived text, a tsvector with its index, and around
200 passage embeddings (halfvec, 384–768 dims) with an HNSW index. A search-only
index, with passages but without `words`, is about half that. So:

- 100 meetings ≈ 150 MB, which fits any free tier.
- 1,000 meetings ≈ 1.5 GB.
- 10,000 meetings (every body in Alaska for years) ≈ 15 GB.

**The text is small.** Even at 10k meetings it is a single-digit-GB database. Only
media and document originals are big, and they are write-once files. That fact
drives most of the decisions below.

## Question 1: Could we use only blob storage?

That would mean publishing each meeting as static files to R2 or S3, plus a
prebuilt search index, with no database at all.

**What works, and fits the principles:**

- **Every page a reader visits.** A meeting is an immutable document once
  ingested. Its transcript, people, documents and audio can all be files on a
  CDN, with no compute behind them.
- **Bulk downloads.** A SQLite file and Parquet or JSONL dumps are the cheapest
  way to serve "give me everything", and they are what lets a user's own agent do
  its own analysis. They can also be mirrored to the Internet Archive or Hugging
  Face datasets, so the data survives even if this project doesn't.
- **Browser-side keyword search.** Pagefind, or a SQLite FTS5 file queried over
  HTTP range requests (the sql.js-httpvfs approach), fetches only the index pages
  a query needs, with zero server compute.

**What breaks:**

1. **Authoring needs a database.** `identify.ts` does a nearest-neighbour search
   over every known voiceprint on each ingest. It creates people, and a meeting's
   commit is all-or-nothing. Naming a person or reassigning a speaker touches
   every meeting they appear in. That work needs transactions and indexes.
2. **AI tools need a server-side search endpoint.** A browser-shard index works
   for a person typing in a search box. It does not work for Claude, Gemini or
   ChatGPT calling `search(q, person, body, date_range)`. Those tools fetch URLs
   or call MCP tools; they don't run our JavaScript.
3. **Browser-side search is heavy on phones at our target scale.** Range-request
   SQLite and Pagefind are fine for hundreds of meetings. At thousands, and on a
   phone with a weak connection, a server query is faster and more reliable.

**Verdict:** split **authoring** from **publishing**.

- **Authoring** (the pipeline and editors) keeps a real database. It is private
  and off the request path. Nobody reading the site ever wakes it up.
- **Publishing** is a build step (`om publish`) that renders everything readers
  need into static files in R2, plus one small read-only search index. That index
  is the only thing a reader's request can touch besides files.

So yes: blob storage becomes the primary home of the published site. It just
isn't the system of record.

## Question 2: Which database?

There are now two separate choices: the authoring database, and the public search
index.

### Authoring: keep Postgres

Nothing about the new principles argues against the Postgres we already have. The
pipeline, `identify.ts`, jsonb generated columns and drizzle migrations all stay.
Because readers never touch it, it can sit on Neon's free tier (0.5 GB, 100
CU-hours/month, and it scales to zero after 5 minutes idle). It is woken only by
`om ingest`, `om publish` and editors. If it outgrows the free tier, the likely
bill is storage at $0.35/GB-month.

### Public search index: D1

The search index is derived and read-only. The publish step rebuilds or
incrementally loads it, and nothing else writes to it. That removes every reason
we had for avoiding D1: no interactive transactions are needed, and there is no
schema or ingest rewrite, only an export.

These are the realistic options, all near-$0 at our size. Prices were checked in
September 2026; confirm them before committing.

| Option                                       | Idle cost                                                                            | At ~1k meetings                                 | BM25                                                                                                                                                                        | Vectors                                                                                  | Notes                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare D1** (SQLite)                   | $0 on free tier (5 GB). On Workers Paid ($5/mo), 5 GB and 25B row reads/mo included. | $0–5/mo flat                                    | **FTS5 with built-in `bm25()`**: real BM25, free                                                                                                                            | Separate service: **Vectorize** (free tier is 5M stored dims; queries $0.01 per 1M dims) | Runs next to the Worker, with no cold start. The free tier fails closed. Max 10 GB per database, so shard by state if we ever get there.             |
| **Neon Postgres** (the authoring DB, reused) | $0: scales to zero                                                                   | ~$0.50/mo storage, plus $0.106/CU-h while awake | Native `tsvector` (ranked, not true BM25). True BM25 via `lakebase_text`; free-plan availability unconfirmed. **ParadeDB `pg_search` was removed from Neon on 2026-09-21.** | pgvector                                                                                 | One system, but readers' traffic now wakes the authoring DB. Cold starts on first query. Compute bills scale with readers, which breaks principle 2. |
| **Turso / libSQL**                           | Generous free tier                                                                   | ~$0–5/mo                                        | FTS5                                                                                                                                                                        | Native vector columns                                                                    | Like D1, with vectors built in, but on another vendor.                                                                                               |
| **Static SQLite over HTTP range requests**   | $0                                                                                   | $0 (R2 storage only)                            | FTS5, run in the browser                                                                                                                                                    | Brute force, in the browser                                                              | Zero server compute, but humans only (see Q1). A good bonus alongside the server index.                                                              |

**Recommendation:**

1. `om publish` builds **one SQLite file**: passages, FTS5, and meeting, person,
   body and document metadata.
2. That same file is:
   - loaded into D1, where it backs the search endpoint;
   - uploaded to R2 as the downloadable dataset;
   - optionally used for browser-side range-request search.

   One artifact, three uses.

3. For semantic search, add Vectorize later (see Q3), with metadata filters on
   body, person and date.

Keep search behind one `features/search` function so the backend stays swappable.

## Question 3: How should search work?

### The unit of search is a passage

A segment is one speaker turn, which can run for minutes. A hit should deep-link
to the right _second_ of video or the right _page_ of a PDF, and an embedding of a
5-minute ramble or a 300-page packet is mush. So `om publish` derives a
`passages` table that covers both transcripts and documents:

```
passages(id, kind,              -- 'transcript' | 'document'
         meeting_id, body_id, meeting_date,
         person_id, start_secs, end_secs,      -- kind = 'transcript'
         document_id, page,                    -- kind = 'document'
         text)
passages_fts USING fts5(text, content='passages')
```

- **Transcript passages** are roughly 30–60 s, or ~100–200 words. They are cut
  from one segment on sentence or word boundaries with a small overlap, and never
  cross a speaker change.
- **Document passages** are one page, or part of a long page. The page number
  gives a deep link: `packet.pdf#page=37`.
- Passages are denormalized (body, date, person) so filtered queries need no
  joins, and they are rebuilt at any time from the authoring database.

### Query types, and what each one needs

| Query                                                                                     | Mechanism                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Everything person Y said"                                                                | **Not a search problem.** It is a filter: `WHERE person_id = ? ORDER BY meeting_date, start_secs`. It is also a static page per person, paginated, with no search at all. |
| Exact phrase or keyword ("Resolution 2026-14", "Alyeska")                                 | BM25 over FTS5, with a phrase query when the term is quoted                                                                                                               |
| Topic ("what was said about housing density")                                             | BM25 first; hybrid BM25 plus vectors, fused with RRF, when we add semantic                                                                                                |
| Scoped versions of any of the above (by person, body, date range, transcript or document) | `WHERE` on the denormalized passage columns                                                                                                                               |
| "Summarize the debate on X" or "what did the packet say vs. what was said"                | The user's AI calls our search, reads the passages, and writes the answer (principle 3)                                                                                   |

### Semantic search matters less than it used to

When the searcher is an LLM, it rewrites "housing density" into several keyword
queries on its own ("ADU", "zoning", "lot size", "multifamily"), and it reads
results well. That covers most of what embeddings would add. Semantic search
mostly helps humans typing vague queries. So:

1. **Now:** FTS5 BM25. Snippets come from `snippet()`, and ranking from `bm25()`
   with a boost for document titles.
2. **Later, if humans need it:** embed passages at publish time (our cost, once
   per meeting) into Vectorize. Queries need embedding at request time; Workers
   AI has a free daily allowance, and a short query is tiny. The same model must
   embed both documents and queries. Record the model name so a change triggers a
   re-embed.
3. **Chapters (#25)** are the best semantic targets of all. Generate them once
   per meeting, publish them as static text, and index them as passages.
4. **Publish the embeddings in the bulk download too,** so a user's own agent can
   do semantic search over them with its own compute.

## Question 4: Meeting documents (agendas, packets, bills, minutes)

Documents are write-once files, so they follow the same pattern as audio: the
original lives in blob storage, and derived text goes to the index.

**Storage:**

- Keep the original, byte for byte, in R2 under a content-addressed key
  (`docs/<sha256>.<ext>`). The same packet is often posted several times, or
  under several meetings, and hashing dedupes it for free.
- Keep the source URL too. Municipal sites reorganize and links rot, so our copy
  may become the only one.
- Budget roughly 20 GB per 1k meetings, which is ~$0.30/month on R2 with no
  download fees.

**Extraction** runs in the pipeline, once per document, on our compute:

- **PDF with a text layer:** extract text per page (pdftotext, MuPDF or pdf.js).
- **Scanned pages:** detect pages with no text layer and OCR them
  (ocrmypdf/Tesseract). Packets often mix both kinds.
- **.docx:** pandoc or mammoth. **Legacy .doc:** convert with LibreOffice
  headless first.
- **Tables and layout:** for packets full of tables (budgets, fee schedules),
  docling or marker produce much better Markdown than plain text extraction.
  They're slower, but it's a one-time cost per document.

**Publishing:** next to each original, publish its extracted text as Markdown,
one file per document, with page markers. It is what an AI reads (a 30 MB PDF is
expensive for an LLM; 200 KB of Markdown is not). It is also what a screen reader
reads, which is an accessibility win many packets don't offer today.

**Schema** (authoring DB):

```
documents(id, sha256, blob_key, source_url, kind, title, page_count, fetched_at)
meeting_documents(meeting_id, document_id, role)   -- agenda | packet | minutes | attachment
document_pages(document_id, page, text, ocr bool)
```

`meeting_documents` is many-to-many because a bill (ordinance, resolution) is
introduced, heard and adopted across several meetings. Later, an
`agenda_items` / `matters` table can tie together:

- a bill's text;
- every meeting it came up in;
- the timestamps where it was discussed (from chapters, #25);
- who said what about it.

That join ("AO 2026-14: text, history, and debate") is probably the single most
valuable page this project could produce.

**Where to get documents:** many cities publish through Legistar, Granicus,
CivicClerk, PrimeGov or CivicPlus, and several of those have public APIs or
predictable URLs. Write one fetcher per platform, as we did with YouTube channels
via `video_sources`.

## Question 5: Audio and video

**What Opus is:** Opus is an open, royalty-free audio codec, the one used by
WhatsApp, Discord and Zoom. It is very efficient for speech: at 24–32 kbps, a
voice recording sounds clear. MP3 needs roughly twice that for similar quality,
and the pipeline's `audio.wav` (16 kHz, 16-bit) is ~256 kbps.

- Opus in an Ogg or WebM container plays in every current browser. Safari added
  Ogg Opus in 18.4 and played WebM Opus before that.
- If very old iPhones matter, an AAC `.m4a` at ~48 kbps is the universal
  fallback, at about twice the size.

**Video:** keep using YouTube as the host and player. Hosting video ourselves is
the only thing here that would cost real money: ~2.5 GB per meeting is ~2.5 TB
per 1k meetings, which is ~$25–40/month even on cold storage.

**Audio:** store an Opus copy of each meeting in R2. That is ~28 MB per meeting,
or ~28 GB per 1k meetings, which is ~$0.40/month on R2 Standard. The first 10 GB
are free and there are no egress fees. It unlocks four things:

- re-running the pipeline without going back to YouTube;
- a working page when YouTube removes or privatizes a video;
- "play just this clip" with no YouTube dependency (#14, #15);
- voiceprint recomputation.

Ingestion already has `audio.wav` locally, so uploading an Opus encode is one more
cached stage.

**Original video archive (optional):** only if preservation becomes a goal. Use R2
Infrequent Access ($0.01/GB-month) or Backblaze B2, written once and rarely read.
Store keys on `meetings` (`audio_key`, `video_archive_key`) rather than URLs, so
buckets and CDNs can change.

## Question 6: How users' AIs reach the data

Most people won't install anything, so the paths are ordered by setup effort, from
none to some:

1. **Search engines.** Crawlable static pages with good titles and schema.org
   markup mean Google (and its Gemini answers) and other engines can already
   answer "what did the Assembly say about X" from our pages. This path needs
   zero setup from anyone.
2. **Paste a link into any chatbot.** Every page has a plain-text or Markdown
   twin (`/meetings/123.md`, `/documents/<id>.md`), and search is a plain GET that
   returns readable text (`/search.md?q=...&body=...`). Any AI with web browsing
   can use it: "read open-minutes.org/search.md?q=snow+removal and tell me what
   the Assembly decided". Add an `llms.txt` describing these URLs.
3. **A remote MCP server** at a fixed URL, with no auth and read-only tools:
   - `search`
   - `get_meeting`
   - `get_document`
   - `get_person`
   - `list_meetings`

   Claude supports custom remote MCP connectors on every plan, including Free
   (limited to one custom connector). Gemini accepts a custom MCP server URL
   under Connected Apps on personal accounts, currently limited to the US and
   users 18+. It is one Worker route in front of the same search index.

4. **Bulk downloads** (SQLite, Parquet, JSONL, embeddings) for agents with code
   execution, researchers and newsrooms.

All four read the same published files and the same search index.

## Question 7: What changes if we add transactional features

The brainstorm is tracked in #34. Under these principles, most of it gets simpler.

- **No LLM features on our servers,** so there are no per-user quotas or billing.
  The cost risk named in the earlier draft of this ADR is gone.
- **Accounts only for editors and maintainers,** never for readers. Cloudflare
  Access in front of the edit routes is enough at first. That is free up to 50
  users.
- **Corrections from the public** go through an anonymous "suggest a fix" form,
  protected by Turnstile rather than an account. Suggestions land in a moderation
  queue in the authoring DB. Once one is applied, the next publish ships it.
- **Alerts:** static RSS/Atom feeds per body, person and saved keyword, generated
  at publish time, cost nothing. Email alerts, if ever, go through a hosted
  newsletter or feed-to-email service rather than a mailer of our own.
- **The public site stays static.** Writes happen only in the authoring database.
  Readers are never on a write path, so scale-to-zero keeps working.
- **What still costs money is per meeting, not per user:**
  - transcription;
  - OCR;
  - chapter and summary generation;
  - user-requested ingestion (if we allow it), which goes through a queue with a
    per-day cap on _meetings processed_, not on users.

## Cost at 1,000 meetings

| Item                                                            | Monthly                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| R2: audio (~28 GB), documents (~20 GB), published files (~1 GB) | ~$0.60                                                         |
| Workers + D1 (search index, MCP)                                | $0 (free tier) or $5 (paid plan)                               |
| Authoring Postgres (Neon, off the request path)                 | $0 (free tier) to ~$1                                          |
| Static page views                                               | $0 when served as prerendered static assets or from edge cache |
| **Total**                                                       | **~$1–7**                                                      |

The per-meeting pipeline cost (a CPU for transcription and OCR, plus LLM calls
for chapters) is separate. It is a one-time cost per meeting.

## Decision

1. **Split authoring from publishing.**
   - Postgres (Neon, free tier) stays as the private system of record for the
     pipeline and editors.
   - `om publish` renders the public site's data to static files in R2.
   - No reader request touches Postgres.
2. **Prerender or edge-cache every public page.** Each page gets a `.md` twin, and
   the site publishes an `llms.txt`.
3. **Search:**
   - `om publish` builds one SQLite file (passages covering transcripts and
     documents, plus FTS5 BM25);
   - that file is served from D1 behind a GET endpoint and a no-auth MCP server;
   - it is also published as a download.
   - Semantic search (Vectorize) comes later, if human users need it.
4. **Audio and documents:**
   - Store an Opus audio copy per meeting in R2.
   - Store original documents, content-addressed, in R2, with text extracted per
     page (OCR where needed) and published as Markdown.
   - Keep YouTube for video.
5. **No LLMs, accounts or quotas for readers.**
   - Users bring their own AI.
   - Our compute budget is per meeting.
   - Anonymous abuse protection: edge cache, per-IP rate limits on search, and
     free tiers that fail closed.
