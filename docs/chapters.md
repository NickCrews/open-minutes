# Chapters

Status: research notes and proposed requirements, written for
[#40](https://github.com/NickCrews/open-minutes/issues/40). Chapters work is
tracked in the map [#25](https://github.com/NickCrews/open-minutes/issues/25)
and its tickets (#26 rendering, #27 gold chaptering, #28 schema, #29 generation,
#30 long meetings, #33 meeting-page UI). This doc does not replace those
tickets. It collects findings and proposes answers to their open questions.
Where it proposes changing a decision already made on #25, it says so.

## What chapters are for

A chapter works as a table of contents entry for a meeting. It has four jobs:

1. **Summarize.** Reading the chapter titles top to bottom should tell you
   what the meeting covered, in about the time it takes to read a paragraph.
2. **Attribute.** For each chapter you can see who spoke, and roughly how
   much.
3. **Navigate.** You can seek or scrub to the part you care about, in the video
   and the transcript at once.
4. **Share.** A chapter is a shareable snippet of the meeting. It has a stable
   URL that keeps working after someone lightly edits its title or nudges its
   start or end time.

Anything a chapter carries should serve one of those jobs. The same
jobs apply to an agent reading the data (see [Agent UX](#agent-ux)), where the
payoff is cost: a chapter outline of a 3-hour meeting is roughly 2k tokens,
compared with roughly 50k for the transcript.

## Prior art

### citymeetings.nyc

[citymeetings.nyc](https://citymeetings.nyc/) is Vikram Oberoi's site for NYC
Council and Charter Revision Commission meetings. It is the closest existing
product to this one. Sources: his write-ups
[How citymeetings.nyc uses AI to make it easy to navigate city council meetings](https://vikramoberoi.com/posts/how-citymeetings-nyc-uses-ai-to-make-it-easy-to-navigate-city-council-meetings/)
and
[A UX-centric approach to navigating city council hearings with LLMs](https://vikramoberoi.com/posts/a-ux-centric-approach-to-navigating-city-council-hearings-with-llms/),
the interview
[Anatomy of an AI-Driven Civic Tech Product](https://www.maximumnewyork.com/p/citymeetings-interview),
and the live site as of 2026-09. Examples:
[a stated meeting](https://citymeetings.nyc/meetings/new-york-city-council/2026-01-07-1200-pm-stated-meeting/)
and
[a single chapter page](https://citymeetings.nyc/meetings/new-york-city-council/2026-01-07-1200-pm-stated-meeting/chapter/council-member-linda-lee-nominates-julie-menin-for-speaker/).

**Structure.** Each chapter has a **type**, a **title**, a **description**
(one lead sentence followed by several bullets), a **start time**, and a
**duration**. Types seen: `QUESTION`, `TESTIMONY`, `REMARKS`, `PROCEDURE`,
`INVOCATION`, `VOICE VOTE`, `VOTE OUTCOME`. The meeting page shows type chips
with counts, for example "REMARKS (51)", and lets you filter by type. In at
least one hearing, `PROCEDURE` chapters appear in the counts, "PROCEDURE (3)",
but were not in the default list.

**Identity.** Each chapter has a numeric database ID (`data-chapter-id="34742"`
in the page), but the public URL uses a slug made from the title, for example
`/meetings/new-york-city-council/2026-01-07-1200-pm-stated-meeting/chapter/council-member-linda-lee-nominates-julie-menin-for-speaker/`.
The slug is scoped to the meeting, which is itself a slug of body, date and
time. Near-duplicate titles still get distinct slugs because the titles differ
slightly ("…althea-stevens-explains-her-vote-for-julie-menin" and
"…althea-v-stevens-explains-her-vote-for-speaker-menin"). Neither the ID nor
the slug is based on time, so a link breaks if a chapter is retitled or
regenerated.

**Granularity is per speaker turn, not per topic.** A chapter begins where a
council member's question begins, where an individual's testimony begins, where
standalone remarks begin, or where a procedural section begins. Oberoi reports
about **44 chapters for a 2.5-hour meeting**, around 3.4 minutes each on
average. On the stated meeting above, chapters run from 8 seconds ("CM Althea
Stevens explains her vote") to 6 minutes. There are 55 chapters in 1h55m.

**Titles are formulaic by type, and the speaker is in the title.**

- Question: the title is phrased as a question. The description answers it and
  says who answered.
- Testimony and remarks: the title reads "[Speaker] on [Topic]", for example
  "Council Member Linda Lee nominates Julie Menin for Speaker".
- Procedure: a basic title and a one-sentence description.

**Chapters do not partition the meeting.** In the stated meeting, the first
chapter starts at 0:06:27, and there are gaps between chapters (a chapter at
0:39:49 lasts 11s, and the next one starts at 0:40:20). There also appear to be
near-duplicate chapters, for example two "Althea Stevens explains her vote"
entries. Oberoi relies on the transcript to cover for imperfect boundaries.
Transcript sentences have timestamps "to leave a margin for error when LLMs
inevitably mess up chapter boundaries".

**Hierarchy exists, but only in the pipeline.** A human marks the major parts
of a meeting in about 5 minutes per meeting: opening remarks, agency testimony,
council questioning, public testimony. AI then finds the chapters inside each
part. The public UI shows a flat list.

**Take the UX, not the pipeline.** Oberoi's write-ups describe how he
generates chapters with 2024-era models: prompt steps, time markers, human
review tooling. We deliberately don't record that here. Models and agentic
workflows in late 2026 are much stronger, and our generation should be designed
from scratch for them. What we want from citymeetings.nyc is its user experience
and chapter semantics, described in the rest of this section. Don't copy its
implementation.

**Navigation UX.** Chapters, video, and transcript sit side by side. Each
chapter has its own page and permalink, which shows the summary and that
chapter's slice of the transcript with previous and next links. You can also
permalink a single transcript sentence. The newsletter links into chapters.
Sharing a 3-minute moment out of a 12-hour hearing is the core use case.

**Takeaways for us.**

- Speaker-turn granularity fits NYC's large, formal hearings, where the unit
  people care about is one person's testimony or question. Girdwood's Board of
  Supervisors is small and conversational, and it is organized by agenda item.
  A 10-minute discussion of one agenda item among five supervisors is one
  topic, not ten remarks. Topic-level chapters of 1 to 15 minutes, as #25
  specifies, are the better default. Speaker-turn detail can come from the
  derived speaker list instead.
- Chapter types (kinds) are useful, cheap, and filterable. We should have
  them. See the [data model](#proposed-data-model).
- A per-chapter permalink with a transcript slice is valuable for both humans
  and agents.

### YouTube chapters

Source: [YouTube Help: Video Chapters](https://support.google.com/youtube/answer/9884579).

- Creators write chapters as timestamps in the description, or YouTube
  auto-generates them. The rules are that the first timestamp must be `00:00`,
  there must be at least 3 chapters in ascending order, and each chapter must
  be at least 10 seconds long. If any rule is broken, no chapters are shown.
- As a result, **YouTube chapters always partition the video**. A chapter is
  only a start time, and it ends where the next one starts.
- **Scrubber.** The progress bar is split into segments with small gaps between
  them, one per chapter. Hovering a segment enlarges it and shows the chapter
  title and a thumbnail above the cursor. Clicking seeks to the exact position
  clicked, not to the chapter start.
- The **current chapter title** is shown next to the time readout ("• Title
  ›"). Clicking it opens a chapter list panel with thumbnails and start times,
  and clicking a list entry seeks to that chapter's start.
- Chapters also appear as "Key moments" in Google search results. That is the
  same deep-link idea as citymeetings permalinks.

### Spotify podcast chapters

Sources: [Spotify for Creators: Episode chapters](https://support.spotify.com/us/creators/article/episode-chapters/),
[Podnews on Spotify chapter support](https://podnews.net/update/spotify-chapters).

- Chapters come from timestamps in the description, as on YouTube, or are
  auto-generated from the transcript. Creators can edit auto-generated
  chapters or turn them off.
- The **current chapter title sits under the progress bar**. The now-playing
  view marks chapters on the bar, and a **chapter list** appears when you
  scroll down. The episode page has its own Chapters section.
- A Spotify community idea asks to move the chapter preview away from the
  progress bar, which suggests the preview gets in the way there. Our hover
  preview should sit above the bar and never cover the thumb.

### Podcasting 2.0 JSON chapters

Source: [podcast-namespace JSON chapters](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/examples/chapters/jsonChapters.md).

This is the open standard for podcast chapters. The only required field is
`startTime`. `endTime` is optional, and **`toc: false`** marks a "silent"
chapter that exists for timing but is hidden from the table of contents. That
is a standard way to express "this span is covered but not worth listing",
which fits procedural material. The format is also a possible export format
later.

## Should every meeting be totally partitioned?

#25 settled that **chapters may have gaps** and store explicit `start_secs` and
`end_secs`. It also noted the resulting problem: the judge has to tell a missed
topic from a deliberate gap. The options:

| Option                                                                     | For                                                                                                                                                                                                                                      | Against                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Total partition** (YouTube style, start-only)                         | Simple model: an end is the next start. The scrubber is always fully segmented. "What chapter is 1:23:00 in?" always has an answer. Silence can't hide a missed topic.                                                                   | Forces the model to title dead air, recesses, and roll call. Boundaries inside long pre-meeting silence are arbitrary. A missed topic gets absorbed silently into its neighbour's time range, which is arguably worse. |
| **B. Sparse, gaps allowed** (citymeetings style; the current #25 decision) | Only substantive material is chaptered. No filler titles.                                                                                                                                                                                | A gap is ambiguous: is it procedural, a recess, or a miss? The scrubber has holes that need their own design. The active chapter is often "none". The judge must reason about gaps (#25).                              |
| **C. Near-total coverage with typed chapters** (recommended)               | Every stretch of real content belongs to a chapter, and low-value stretches are explicit: `kind = procedural` or `break`. A remaining gap then clearly means no content, or a miss. The TOC can hide low-value kinds, like `toc: false`. | Slightly more output per meeting. We have to define the kinds.                                                                                                                                                         |

**Recommendation: C, which amends #25 but does not reverse it.** Keep the schema
as #25 and #28 decided: ordered, non-overlapping chapters with explicit
`start_secs` and `end_secs`, and gaps legal. But ask the generator to _cover_
the meeting, and to label procedural stretches (call to order, roll call,
approving the agenda and minutes, adjournment) and breaks (recess, technical
difficulties, dead air before the gavel) as chapters of those kinds, instead of
leaving them out. Legal gaps then mean:

- a short gap (under about 30 seconds) between adjacent chapters, which is
  boundary slop, or
- a stretch with no speech at all, for example before the stream starts.

This makes the #25 eval problem tractable. Any uncovered stretch of speech
longer than N seconds is flagged as a candidate miss, mechanically. The judge
council then only needs to decide whether a `procedural` label hides
substance, which is a much narrower question. It also means the gold
chaptering (#27) should use the same kinds, so the human's "deliberate gap"
decisions are written down instead of implied.

**Nesting.** #25 put hierarchical chapters out of scope for v0, and that should
stay. The natural second level is the **agenda item**. Girdwood meetings follow
a published agenda, and citymeetings uses a human-marked top level ("agency
testimony", "public comment"). When nesting arrives it should probably be a
separate `agenda_items` table (or chapters with `parent_id`) that is sourced
from the published agenda where one exists, not invented by the model. For v0,
the one cheap hedge is to let a chapter optionally carry an agenda reference
string such as `"7.b"`, which can later be promoted into a foreign key. This is
listed under open questions.

**Overlap.** Keep chapters non-overlapping (#29 validates this). Real meetings
do interleave, for example returning to an item after public comment. Model
that as two chapters with similar titles. Do not overlap them.

## Granularity

- #25 specifies 1 to 15 minutes and 3 to 7 bullets. Keep that for `topic`
  chapters. Procedural and break chapters can be any length (a 20-second roll
  call, a 40-minute recess) and get 0 to 1 bullets.
- Expect roughly 10 to 30 chapters for a 2.5-hour Girdwood meeting.
  citymeetings' roughly 44 is the per-speaker end of the range.
- Long public comment periods are the hard case. One chapter per commenter is
  what citymeetings does, and it suits the "find the 3-minute testimony" use
  case. One chapter for the whole period loses the attribution job. Suggestion:
  one chapter per commenter when a commenter speaks for more than about a
  minute, otherwise group them. Validate this against #27.
- Scrubber legibility sets a lower bound. On a roughly 700px bar, a 1-minute
  chapter in a 3-hour meeting is about 4px wide, which is still visible. Below
  about 2px, segments merge visually, so the scrubber needs a minimum rendered
  width and should drop the separating gap for tiny segments.

## Speakers per chapter: derive, don't store

A chapter's speakers should be **computed from `segments` whose time ranges
intersect the chapter**, with speaking seconds per speaker. They should not be
emitted by the model or stored on the chapter. Reasons:

- Speaker identity changes after ingest. Humans name `speaker 3`, and ADR 0002
  adds cross-meeting recognition. A stored list would go stale. A derived list
  picks up every relabel for free.
- It is exact where the model would be approximate.
- The web already has the machinery (`tallySpeakers`/`assignSpeakers` in
  `packages/web/src/features/meetings/speakers.tsx`). Restricting it to a time
  window is a small change. For agents, the same logic belongs in a SQL view
  (for example `chapter_speakers`) so any client gets it.

Titles and bullets may still _name_ people, as citymeetings titles do, when the
transcript identifies them. Doing so is prose, not the attribution mechanism.
The rendering decision in #26 about how `unlabeled` and `segmented` speakers
appear to the model decides whether the model can name anyone at all.

## Web UX

### Current page, for reference

`packages/web/src/routes/meetings_.$id.tsx`: a header with title, body, start
time, and duration. Then two columns on `lg`:

- **Left (3/5):** the YouTube iframe (with its own native controls),
  `<Speakers>` (speaking-time bars, which double as the color legend), and the
  meeting description.
- **Right:** `<Transcript>` with a search box, the scrolling word-synced
  transcript with auto-follow, and a **bottom toolbar**. The toolbar has the
  elapsed time, speed, ±15s, play and pause, return-to-playhead, and remaining
  time. There is **no scrubber of our own**. The only progress bar is inside
  the YouTube iframe, and we can't draw chapters on it.

Seek plumbing is shared: the route's `seekTo(secs)` sets `currentTime`,
suppresses polling for 800ms, and calls `player.seekTo`. `currentTime` updates
about every 250ms from polling.

### 1. Chapter scrubber (new, and useful even without chapters)

Add a scrubber row **directly above the transcript toolbar**, between the
transcript and the play controls, where YouTube and Spotify put it:

- A full-width bar in which **each chapter is a segment**, with a 2px gap
  between segments. The played portion is filled, and the playhead is a thumb.
- **Gaps and low-value kinds are drawn differently.** Uncovered time is a
  muted, hatched segment. `procedural` and `break` are lower contrast. The eye
  should land on substantive chapters.
- **Hover** shows a tooltip _above_ the bar with the chapter title, the hovered
  timestamp, and the chapter's time range. Per the Spotify complaint, it must
  never cover the bar.
- **Click** seeks to the clicked position, as on YouTube. **Drag** scrubs,
  calling `seekTo(secs, false)` while dragging and `seekTo(secs, true)` on
  release. Clicking a chapter _in the list_ seeks to the chapter start. The
  scrubber should call the route's `seekTo`, so the 800ms poll suppression and
  the transcript auto-follow behave the same way as a transcript click.
- **Current chapter label** next to the elapsed time, for example "12:34 ·
  Snow removal contract ›". It is truncated, and clicking it opens the Chapters
  tab.
- Accessibility: `role="slider"` with `aria-valuetext` such as "12:34, in
  chapter: Snow removal contract". Arrow keys step 5s, and PageUp and PageDown
  jump to the previous or next chapter start. Kobalte (already a dependency)
  has a Slider primitive to build on.
- **With no chapters** it is a single-segment plain scrubber. That is still an
  improvement, and it removes the need for the iframe's own bar.
- Optional later: a thin **speaker lane** under the bar, colored by who is
  talking, using the existing `speakerColor`. It shows attribution over time at
  a glance.

Open: whether to hide YouTube's native controls (`controls: 0`) once our
scrubber exists, to avoid having two progress bars. Fullscreen and captions
live in those controls, so this needs a decision.

### 2. Tabs in the left column

The left column under the video becomes a tabbed pane, using Kobalte `Tabs`:

- **Summary** (or "Info"): the meeting description today. Later, a generated
  meeting summary, which could be built from chapters and would itself be a
  chapter consumer. Also agenda and document links when those exist.
- **Chapters:** the table of contents.
- **Speakers:** the existing `<Speakers>` list.
- Room for more later: Votes, Documents, Notes.

Behavior:

- Default to **Chapters** when the meeting has chapters, otherwise
  **Summary**. With no chapters, the Chapters tab is hidden, not shown empty.
  This satisfies the #33 requirement of "no empty state that looks broken".
- Store the selected tab in the URL search params (`?tab=chapters`) so it is
  shareable and survives reload.
- On mobile the columns already stack, and tabs stay under the video.

This answers the placement question in #33 (rail vs header vs third column).
The recommendation is **a tab in the left column**. A third column crowds the
transcript, and a header above the transcript pushes it down. The tab reuses
space the Speakers list and description already occupy.

### 3. Chapters list

Each row shows:

- start time (a link that seeks), title, duration, and a kind badge for
  non-topic kinds;
- **speaker swatches** for the top 2 or 3 speakers by speaking time in that
  chapter, with "+N" for the rest and a hover card listing all of them. This is
  the attribution job;
- bullets **expanded on the active chapter** and collapsed elsewhere, with
  click to expand any chapter. That keeps the list scannable as a TOC while the
  current chapter shows detail. This answers the "bullets" question in #33.

The **active chapter** is highlighted, found by binary search over chapter
starts in the same way `Transcript` finds the active segment. When the playhead
is in a gap, nothing is highlighted, and an optional thin marker between rows
shows where the playhead is. The list auto-scrolls to keep the active chapter
visible, and manual scrolling pauses that, mirroring the transcript's
follow/return-to-playhead behavior.

A toggle at the top ("Show procedural") hides `procedural` and `break` rows by
default, following the citymeetings type filter and the `toc: false` idea.
Hidden chapters still appear on the scrubber.

### 4. Chapters inside the transcript

Render a **chapter heading divider** inline in the transcript at each chapter
start, showing the title and time. It gives readers context while scrolling
and makes boundary errors easy to see. Oberoi's reason for keeping sentence
timestamps visible is that boundaries will be wrong. Transcript search could
match chapter titles too. #25 lists "chapters as a search surface" as a later
question.

### 5. Permalinks

- `?t=<secs>` on the meeting URL: seek on load.
- `?chapter=<id>` (or a slug): seek to the chapter start and open the
  Chapters tab. A dedicated chapter page, as on citymeetings, can come later.
  The query param gets most of the value.
- Chapter links must survive small edits (see [Share](#what-chapters-are-for)),
  so they use an opaque chapter ID. They must not use a title slug, which
  breaks when the title is tweaked, or the start time, which breaks when a
  boundary is nudged. Editing a chapter's title or times updates its row in
  place and keeps its ID. Whether IDs also survive a full regeneration is open
  question 9.
- A "Copy link" action on each chapter row.

### 6. Speakers tab, scoped

Optional: a toggle on the Speakers tab between "Whole meeting" and "This
chapter". This comes almost free from the derived per-chapter tally.

## Agent UX

Assume an agent explores the data through SQL, an `om` CLI, or a future MCP or
HTTP API. Typical tasks and what they need from chapters:

| Task                                                  | What the agent does                                                                                             | Requirement                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "What happened at the Feb 3 GBOS meeting?"            | Reads the chapter outline (titles, times, kinds, top speakers), about 2k tokens.                                | A compact outline rendering, one line per chapter. Filter by kind.                                                      |
| "What did the board decide about X?"                  | Searches chapter titles and bullets across meetings, then reads the transcript slice for the matching chapters. | Full-text search over title, bullets, and summary. Cheap "transcript for chapter" access (segments in `[start, end)`).  |
| "What has Supervisor Y said about housing this year?" | Joins chapters to derived per-chapter speakers, filters by person, searches by topic, reads the slices.         | A `chapter_speakers` view (chapter_id, person_id / speaker_number, speaking_secs). A stable person identity (ADR 0002). |
| "Cite it."                                            | Returns a deep link.                                                                                            | A URL form `/meetings/:id?t=secs` or `?chapter=id`.                                                                     |
| "Is this trustworthy?"                                | Checks provenance.                                                                                              | Model, prompt version, generated-at, and whether a human reviewed the chapters.                                         |

Principles:

- **Chapters are an index, not the source.** An agent should treat titles and
  bullets as pointers and quote the transcript. That argues for making
  `chapter → segments` trivial to query and for grounding bullets (see the open
  question on per-bullet anchors).
- **Flat, consistent granularity** is easier for agents than deep nesting.
  "Top N chapters by speaking time of person P" only makes sense when chapters
  are comparable in size, which is another argument for typed kinds (filter out
  `break`) over sparse gaps.
- **Stable IDs.** Chapter IDs survive edits to a chapter's title and times, so
  an agent can cite a chapter by ID. Use `?t=` to cite a moment inside a
  chapter.
- A CLI view such as `om chapters <meeting> --show`, or an outline format in
  the diffable-text style of `psv.ts`, would serve both humans reviewing output
  (#29, "read the output yourself") and agents.

## Proposed data model

This is a sketch to feed #28, not a final schema. Time columns follow the
existing `secondsInterval()` convention.

```ts
chaptersTable = pgTable("chapters", {
  id: serial().primaryKey(),
  meeting_id: integer()
    .notNull()
    .references(() => meetingsTable.id),
  start_secs: secondsInterval().notNull(),
  end_secs: secondsInterval().notNull(), // explicit: gaps are legal (#25)
  kind: chapterKind().notNull(), // enum, see below
  title: varchar().notNull(), // a few words, TOC-scannable
  summary: varchar(), // optional one sentence: tooltip, collapsed row, agent outline
  bullets: jsonb().$type<string[]>().notNull(), // 3–7 for topic, 0–1 otherwise
  agenda_ref: varchar(), // optional, eg "7.b"; future hook for nesting
  // provenance (#28): which run produced this row
  generation_id: integer().references(() => chapterGenerationsTable.id),
});
// check: start_secs < end_secs; exclusion constraint or app check for no overlap per meeting

chapterGenerationsTable = pgTable("chapter_generations", {
  id: serial().primaryKey(),
  meeting_id: integer().notNull(),
  model: varchar().notNull(),
  prompt_version: varchar().notNull(),
  transcript_fingerprint: varchar().notNull(), // hash of the rendered transcript (#26), for staleness
  generated_at: timestamp().notNull().defaultNow(),
  reviewed_by_human: boolean().notNull().default(false),
});

// derived, not stored:
// view chapter_speakers(chapter_id, person_id, speaker_number, speaking_secs)
//   = segments overlapping [start_secs, end_secs), clipped to the chapter, summed per speaker
```

**`kind` values** (proposed, small on purpose):

- `topic`: substantive discussion, presentation, or deliberation on one
  subject. The default.
- `public_comment`: members of the public speaking.
- `vote`: a motion and its outcome, when it stands apart from the discussion.
  Otherwise the vote goes in the topic's bullets.
- `procedural`: call to order, roll call, pledge, agenda and minutes approval,
  adjournment.
- `break`: recess, technical difficulties, dead air.

The first three are listed in the TOC by default. The last two appear on the
scrubber but are hidden from the list by default.

Notes on reconciling with existing tickets:

- **#25 / #28, gaps:** kept legal. The generator is asked to cover
  (recommendation C), and the schema doesn't enforce it.
- **#28, bullets:** `jsonb string[]`, following the `segments.words`
  precedent. Individual addressability can come later through per-bullet
  anchors, and that is when a separate table would pay off.
- **#28, provenance and regeneration:** a separate generations table lets
  regeneration create a new generation and swap which one is current, rather
  than versioning each row. A fingerprint of the rendered transcript makes
  staleness detectable. That covers "invalidation on re-transcription" from
  #25. A new speaker _label_ doesn't stale a chapter because speakers are
  derived, but a changed transcript does.
- **#29, validation:** ordered, non-overlapping, in-bounds, and 1 to 15 minutes
  for `topic` only. Also check coverage: flag uncovered speech longer than about
  30 seconds.
- **#27, gold:** write the gold chaptering with the same `kind`s, so deliberate
  gaps become explicit `procedural` or `break` entries.
- **#33, UI:** the placement, active-chapter, and bullets questions are
  answered above (tabs, binary search with a gap state, bullets expanded on the
  active chapter). The scrubber and transcript dividers go beyond #33's scope
  and may deserve their own ticket.

## Open questions

1. **Adopt recommendation C?** This means asking the generator for near-total
   coverage with `procedural` and `break` kinds, instead of the sparse
   chaptering #25 and #27 currently describe. It changes the gold-writing
   instructions in #27.
2. **Kind set.** Are five kinds right? Is `vote` worth separating, or is it
   always part of a `topic`? Does Anchorage Assembly need more, such as
   `presentation` or `executive_session`?
3. **Public comment granularity.** One chapter per commenter, grouped, or a
   threshold?
4. **`summary` field.** Is one sentence alongside 3 to 7 bullets redundant? It
   helps tooltips, collapsed rows, and agent outlines. The first bullet could
   do the same job.
5. **Per-bullet time anchors** (`{text, at_secs}`) so every claim links to its
   evidence, for citation and hallucination checks. They cost more to generate
   and validate.
6. **Agenda linkage.** Is `agenda_ref` worth adding in v0, or should it wait
   for a real agenda ingest?
7. **Our scrubber vs YouTube's.** Hide native controls (`controls: 0`), or live
   with two bars?
8. **Human review.** citymeetings relies heavily on human correction. Do we
   need an edit UI (boundaries, titles) before chapters count as trustworthy,
   and how is `reviewed_by_human` set?
9. **Chapter identity across regenerations.** Chapter IDs must survive edits
   to a chapter's title and times. Regeneration (#28) creates new rows, though.
   Should a regenerated chapter inherit the ID of the old chapter it most
   overlaps, so shared links keep working? Or should old IDs redirect to the
   chapter covering their start time?
10. **Export.** Emit Podcasting 2.0 JSON chapters or YouTube description
    timestamps? This would be cheap, and YouTube-format chapters could be
    offered back to the bodies that publish the videos.
