# Chapters

Status: research notes and proposed requirements, written for
[#40](https://github.com/NickCrews/open-minutes/issues/40). Chapters work is
tracked in the map [#25](https://github.com/NickCrews/open-minutes/issues/25)
and its tickets (#26 rendering, #27 gold chaptering, #28 schema, #29 generation,
#30 long meetings, #33 meeting-page UI). This doc does not replace those
tickets. It collects findings and proposes answers to their open questions.
Where it proposes changing a decision already made on #25, it says so.

## What chapters are for

A chapter works as a table of contents entry for a meeting. It has five jobs:

1. **Summarize.** Reading the chapter titles top to bottom should tell you
   what the meeting covered, in about the time it takes to read a paragraph.
2. **Attribute.** For each chapter you can see who spoke, and roughly how
   much.
3. **Navigate.** You can seek or scrub to the part you care about, in the video
   and the transcript at once.
4. **Share.** A chapter is a shareable snippet of the meeting. It has a stable
   URL that keeps working after someone lightly edits its title or nudges its
   start or end time.
5. **Find across meetings.** Chapters are queryable units across the whole
   database, not just within one meeting: for example, all public comment
   ever given, or every discussion of housing. This is why kinds like
   `public_comment` are strict (see [Granularity](#granularity)).

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
  them. See [Chapter kinds](#chapter-kinds).
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
which fits procedural material. The format is also a possible export format,
which is a follow-up and not in v0 (see [Not in v0](#not-in-v0)).

## Coverage: chapters cover the whole meeting

Every stretch of real content in a meeting belongs to a chapter. Low-value
stretches are not left out. They get chapters of their own, with an explicit
kind:

- `procedural`: call to order, roll call, approving the agenda and minutes,
  adjournment.
- `break`: recess, technical difficulties, dead air before the gavel.

The TOC can hide these kinds by default, the way Podcasting 2.0 uses
`toc: false`, but they are still in the data.

The schema stays as #25 and #28 decided: ordered, non-overlapping chapters with
explicit `start_secs` and `end_secs`, and gaps are legal. This amends #25's
"chapters may have gaps" decision but does not reverse it. The generator's job
is to _cover_ the meeting, so the only legitimate gaps are:

- a short gap (under about 30 seconds) between adjacent chapters, which is
  boundary slop, or
- a stretch with no speech at all, for example before the stream starts.

Any other gap is a missed topic. That is the point of this rule: it makes the
#25 eval problem mechanical. Any uncovered stretch of speech longer than N
seconds is flagged as a candidate miss, and the judge council only has to
decide whether a `procedural` label is hiding substance. The gold chaptering
(#27) uses the same kinds, so the human's "deliberate gap" decisions are
written down instead of implied.

Why not the alternatives:

- **Total partition** (YouTube style, start times only, each chapter ends where
  the next begins). It forces titles onto arbitrary spans of pre-meeting
  silence. Worse, a missed topic gets silently absorbed into its neighbour's
  time range, where nothing can flag it.
- **Sparse chapters with free gaps** (citymeetings style, and #25's original
  reading). A gap is ambiguous: it could be procedural, a recess, or a miss.
  The scrubber has holes, the active chapter is often "none", and the judge
  has to reason about every gap.

**No nesting in v0.** #25 put hierarchical chapters out of scope, and they stay
out. When nesting comes, the second level is the **agenda item**. Girdwood
meetings follow a published agenda, and citymeetings uses a human-marked top
level ("agency testimony", "public comment"). Agenda items come from the
published agenda where one exists, not from the model, in a separate
`agenda_items` table or as chapters with a `parent_id`. v0 stores no agenda
link at all. The schema sketch only marks where one would go.

**No overlap.** Chapters never overlap (#29 validates this). Real meetings do
interleave, for example returning to an item after public comment. That is two
chapters with similar titles.

## Chapter kinds

Every chapter has exactly one `kind`. Kinds matter more than anything else on
a chapter except its time range. They are what the
[Find across meetings](#what-chapters-are-for) job queries ("all public
comment", "every vote on the budget"). They decide what the TOC hides, which
length rules apply, and how the gold set (#27) is labelled. Changing the set
later means relabelling every chapter in the database, so it is worth getting
right now.

### How others classify parts of a meeting

**citymeetings.nyc.** Chapter type chips from a sample of 48 NYC Council and
Charter Revision Commission meetings, fetched 2026-09-30. Each chip label maps
to one of seven CSS classes, shown in brackets:

| Label            | Count | Class          |
| ---------------- | ----: | -------------- |
| Q&A              |  1133 | `question`     |
| REMARKS          |   493 | `remarks`      |
| TESTIMONY        |   476 | `testimony`    |
| PUBLIC TESTIMONY |   374 | `testimony`    |
| AGENCY TESTIMONY |   215 | `testimony`    |
| QUESTION         |   210 | `question`     |
| PRESENTATION     |    54 | `presentation` |
| VOTE OUTCOME     |    19 | `unlabeled`    |
| PROCEDURE        |     7 | `procedure`    |
| INVOCATION       |     4 | `invocation`   |
| VOICE VOTE       |     2 | `unlabeled`    |

What this shows:

- The types describe **activity**: who is talking and in what role. They do
  not describe where in the agenda the talk happens.
- The main split is **by speaker role**: council members (questions,
  remarks), agency officials (agency testimony, presentations), and the
  public (public testimony).
- Q&A dominates because NYC oversight hearings are mostly members questioning
  agency officials, one chapter per questioner.
- Procedure barely appears. It is mostly left out, which is the sparse
  approach [Coverage](#coverage-chapters-cover-the-whole-meeting) rejects.
- Votes are rare, and their chips have no styling class (`unlabeled`).
- A separate chip on each _meeting_ (HEARING, VOTE) classifies the whole
  meeting. That is a property of the meeting, not of a chapter.

**Agendas: the order of business.** Real agendas are organized by
_section_, and each section mixes several activities.

- The **Girdwood Board of Supervisors**
  [regular meeting of 2026-02-23](https://www.muni.org/Departments/operations/streets/Service/GBOS/GBOS%20February%2023%20%202026%20agenda%20draft.pdf): Call to
  Order, Land Acknowledgement, Roll Call & Disclosures, Agenda Revisions and
  Approval, Minutes Approval, Consent Agenda, Presentations, Reports
  (legislative, supervisor, committee, standing, and service provider
  reports), Public Comment, Old Business, New Business, Reports, Request for
  Executive Session, Adjourn. GBOS public comment "must be on subjects not
  listed on the agenda"
  ([GBOS Rules & Procedures](https://communitycouncils.org/girdwood/gbos-rules-procedures/)). Public input on agenda
  items happens during Old and New Business instead.
- The **Anchorage Assembly**
  [regular meeting of 2025-12-02](https://meetings.muni.org/AgendaOnline/Documents/ViewAgenda?meetingId=6186&type=agenda&doctype=1): Call to Order,
  Roll Call, Pledge and Land Acknowledgment, Minutes, Mayor's Report, Chair's
  Report, Committee and Liaison Reports, Addendum, Appearance Requests,
  Consent Agenda, Unfinished Business, Continued Public Hearings, New Public
  Hearings, Quasi-Judicial Matters and Special Orders, Audience Participation,
  Assembly Comments, Executive Sessions, Adjournment. A single public hearing
  item typically runs as a staff presentation, then public testimony, then
  Assembly debate and amendments, then a vote.
- **Legistar** ([Web API](https://webapi.legistar.com/Help)), which Seattle and many other cities use, stores agenda items
  with a matter type (Ordinance, Council Bill, Resolution, and so on), an
  action name ("pass", "discussed"), a passed flag, a mover and seconder, a
  tally, and a **video index**. Section headers such as "Call To Order",
  "Public Comment" and "Adjournment" are items with no matter attached.
- **MeetingBank** ([Hu et al., ACL 2023](https://arxiv.org/abs/2305.17529): 1,366 meetings in 6 US cities)
  segments meetings by agenda item, with start and end times taken from the
  city's own video index.

**Data standards.**

- **[Akoma Ntoso](https://docs.oasis-open.org/legaldocml/akn-core/v1.0/akn-core-v1.0-part1-vocabulary.html)**, the OASIS standard for parliamentary records, types
  debate sections: `administrationOfOath`, `rollCall`, `prayers`,
  `oralStatements`, `writtenStatements`, `personalStatements`,
  `ministerialStatements`, `resolutions`, `nationalInterest`,
  `declarationOfVote`, `communication`, `petitions`, `papers`,
  `noticesOfMotion`, `questions`, `address`, `proceduralMotions`,
  `pointOfOrder`, `adjournment`, and a generic `debateSection`. Inside a
  section, each utterance is a `speech`, `question`, or `answer`.
- **[Open Civic Data](https://github.com/opencivicdata/python-opencivicdata)** gives an event agenda item a free-form `classification`
  array with no fixed vocabulary. It does fix the vocabulary for bill
  _actions_ (introduction, reading-1, passage, failure, deferral,
  committee-referral, and so on) and for vote _options_ (yes, no, absent,
  abstain, not voting).
- **[Council Data Project](https://github.com/CouncilDataProject/cdp-backend)** links each meeting to its minutes items, in
  order, and records a `decision` (Passed or Failed) on each item, plus each
  member's individual vote.

### What we take from this

1. **A kind describes activity, not agenda position.** Agenda sections mix
   activities. GBOS Old Business holds presentations, public questions,
   deliberation and votes, and an Anchorage public hearing holds all four in
   one item. A kind that meant "agenda section" couldn't answer "all public
   comment", because a lot of public comment happens inside business items
   and public hearings. Agenda position is a separate axis. It belongs to the
   future agenda link (see [No nesting in v0](#coverage-chapters-cover-the-whole-meeting)),
   not to `kind`.
2. **Speaker role is the main thing that separates kinds.** Every source
   separates the public, invited or official speakers (staff, agencies,
   service providers, legislators), and the body's own members. Our kinds
   follow the same lines. This also makes kinds easy to check against the
   derived speakers.
3. **Votes are first-class everywhere except citymeetings.** Legistar, OCD,
   CDP and Akoma Ntoso all record motions, outcomes and tallies. "Every vote
   on X" is a core cross-meeting question, so a formal vote is always its own
   chapter.
4. **Meeting-level type is separate.** Regular meeting, special meeting, work
   session, hearing and quarterly meeting describe the meeting, not a
   chapter, and belong on `meetings`.
5. **Keep the set small and closed.** Akoma Ntoso's 20 section types are
   built for national parliaments. Small bodies need a handful of kinds that
   a labeller can apply without hesitating. Finer detail (a question versus
   an answer, agency versus invited speaker) comes from the derived speakers
   and the text, not from more kinds.

### The kinds

| `kind`           | What it is                                                                                                                          | Examples                                                                                                                                                                | Closest citymeetings type                  | In the TOC by default |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------- |
| `procedural`     | Running the meeting, not its substance.                                                                                             | Call to order, roll call and disclosures, pledge, land acknowledgement, invocation, agenda and minutes approval, consent agenda passed without discussion, adjournment. | PROCEDURE, INVOCATION                      | no                    |
| `report`         | A scheduled or invited speaker informs the body: a presentation or a report, plus the body's clarifying questions to that speaker.  | Staff presentation on an ordinance, fire chief's report, legislator's report, committee update, supervisor reports, Mayor's report.                                     | PRESENTATION, AGENCY TESTIMONY, Q&A (part) | yes                   |
| `public_comment` | Members of the public speaking, wherever it happens on the agenda.                                                                  | Open public comment, Anchorage appearance requests and audience participation, testimony in a public hearing, a resident speaking during Old Business.                  | PUBLIC TESTIMONY                           | yes                   |
| `discussion`     | The body deliberating among itself: debate, questions to each other, motions, amendments, and member comments not tied to a report. | GBOS debating a letter on solid waste fees, Assembly debate on an amendment, "Assembly Comments".                                                                       | REMARKS, QUESTION                          | yes                   |
| `vote`           | A formal vote on a motion and its announced result. Always its own chapter, however short.                                          | Roll-call vote on an ordinance, voice vote on a resolution of support.                                                                                                  | VOICE VOTE, VOTE OUTCOME                   | yes                   |
| `break`          | No business is being done.                                                                                                          | Recess, executive session (the public stream is paused or the room is empty), technical difficulties, dead air before the gavel.                                        | none (left as gaps)                        | no                    |

`discussion` replaces the earlier `topic`. "Topic" suggested _any_
substantive chapter, which overlapped with `report` and `public_comment`.
Every kind is on some topic. The kinds say what kind of talk it is.

Labelling rules:

- **One kind per chapter.** When the activity changes for longer than about a
  minute, start a new chapter. So an Anchorage public hearing on an ordinance
  becomes a `report` (staff presents), then `public_comment` chapters, then
  `discussion`, then a `vote`, and all of them share the item in their
  titles.
- **Public speakers are always `public_comment`,** even inside a business
  item or a hearing (see [Granularity](#granularity)).
- **Questions to a presenter stay in the `report`** while they clarify what
  was presented. When they turn into debate among the members, start a
  `discussion` chapter.
- **Every formal vote is a `vote` chapter,** including a 10-second voice vote.
  Motions and amendments debated before the vote are `discussion`. A consent
  agenda passed without discussion is `procedural`.
- **Executive session is `break`.** No business is visible to the public. The
  motion to enter it is `procedural`.

Checking the set: when the gold set (#27) is labelled, count how often the
labeller hesitates between two kinds, or two labellers disagree. A pair that
is often confused should be merged. A kind that never occurs in Girdwood or
Anchorage meetings should be dropped.

## Granularity

- #25 specifies 1 to 15 minutes and 3 to 7 bullets. Keep that for
  `discussion` and `report` chapters. `procedural`, `vote` and `break`
  chapters can be any length (a 20-second roll call, a 10-second voice vote, a
  40-minute recess) and get 0 to 1 bullets.
- **Every chapter has a one-sentence summary**, whatever its kind. The
  summary is what tooltips, collapsed list rows and the agent outline show.
  Bullets add detail beneath it.
- **Bullets have no timestamps.** A bullet summarizes the chapter as a whole.
  The points it makes often build up across the whole chapter rather than
  happening at one moment, so bullets are not tied to a time. The chapter's
  time range is the finest time link a chapter has.
- Expect roughly 10 to 30 chapters for a 2.5-hour Girdwood meeting.
  citymeetings' roughly 44 is the per-speaker end of the range.
- Long public comment periods are the hard case. One chapter per commenter is
  what citymeetings does, and it suits the "find the 3-minute testimony" use
  case. One chapter for the whole period loses the attribution job. The rule:
  one chapter per commenter when a commenter speaks for more than about a
  minute, otherwise group them.
- **Public comment is always its own kind.** Every chapter of public comment,
  per-commenter or grouped, has `kind = public_comment` and never `discussion`,
  even when the comment is about a topic being discussed. That makes "all
  public comment across the database" a single query on `chapters.kind`,
  joined to `segments` for the words and speakers.
- **Test the assumptions once we have data.** The rules above assume, for
  example, that in practice nearly every commenter speaks for at least a
  minute, so per-commenter chapters stay inside the 1 to 15 minute range and
  grouping is rare. That is plausible but unverified. When chapters are built,
  add test cases against the gold set (#27) and real output that check it:
  `discussion` and `report` chapters fall within 1 to 15 minutes, the distribution of commenter
  speaking times, and that every public comment stretch is covered by a
  `public_comment` chapter. If an assumption fails, revisit the rule.
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
  improvement.

**YouTube's native controls stay.** Our scrubber does not replace them.
Someone can control playback from either place, and the two stay in sync
through the shared seek plumbing. The native controls also keep fullscreen
and captions.

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
- The selected tab is **not** stored in the URL. A `?tab=` param would make
  shared links too busy.
- On mobile the columns already stack, and tabs stay under the video.

This answers the placement question in #33 (rail vs header vs third column).
The recommendation is **a tab in the left column**. A third column crowds the
transcript, and a header above the transcript pushes it down. The tab reuses
space the Speakers list and description already occupy.

### 3. Chapters list

Each row shows:

- start time (a link that seeks), title, duration, and a kind badge (none for
  `discussion`, the most common kind);
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

There is one link form: `?t=<secs>` on the meeting URL. On load the page
seeks to `t` and highlights the chapter that contains it. There is no
`?chapter=<id>` param and no per-chapter slug.

- A **"Copy link"** action on each chapter row emits `?t=<chapter start>`.
- **Snap rule.** If `t` falls within about 10 seconds before a chapter start,
  resolve the link to that chapter and seek to its current start. This keeps
  chapter links working when a start is nudged a little later.
- This meets the [Share](#what-chapters-are-for) requirement without stable
  chapter IDs. A title edit doesn't touch the link. A boundary nudge is covered
  by the chapter range or the snap rule. Even a full regeneration (#28) lands
  on whatever chapter now covers that moment.
- Link previews (page title, unfurl) use the title of the chapter containing
  `t`.
- A dedicated chapter page, as on citymeetings, can come later if needed.

## Agent UX

Assume an agent explores the data through SQL, an `om` CLI, or a future MCP or
HTTP API. Typical tasks and what they need from chapters:

| Task                                                  | What the agent does                                                                                             | Requirement                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "What happened at the Feb 3 GBOS meeting?"            | Reads the chapter outline (titles, times, kinds, top speakers), about 2k tokens.                                | A compact outline rendering, one line per chapter. Filter by kind.                                                      |
| "What did the board decide about X?"                  | Searches chapter titles and bullets across meetings, then reads the transcript slice for the matching chapters. | Full-text search over title, bullets, and summary. Cheap "transcript for chapter" access (segments in `[start, end)`).  |
| "What has Supervisor Y said about housing this year?" | Joins chapters to derived per-chapter speakers, filters by person, searches by topic, reads the slices.         | A `chapter_speakers` view (chapter_id, person_id / speaker_number, speaking_secs). A stable person identity (ADR 0002). |
| "Cite it."                                            | Returns a deep link.                                                                                            | A URL form `/meetings/:id?t=secs`.                                                                                      |
| "Is this trustworthy?"                                | Checks provenance.                                                                                              | Model, prompt version, generated-at, and whether a human reviewed the chapters.                                         |

Principles:

- **Chapters are an index, not the source.** An agent should treat titles and
  bullets as pointers and quote the transcript. Bullets have no timestamps
  (see [Granularity](#granularity)), so the chapter's time range is the
  pointer. That argues for making `chapter → segments` trivial to query.
- **Flat, consistent granularity** is easier for agents than deep nesting.
  "Top N chapters by speaking time of person P" only makes sense when chapters
  are comparable in size, which is another argument for typed kinds (filter out
  `break`) over sparse gaps.
- **Cite by time.** An agent cites a chapter or a moment with `?t=`, the same
  link a human shares. Chapter IDs are internal and are not part of any URL.
- A CLI view such as `om chapters <meeting> --show`, or an outline format in
  the diffable-text style of `psv.ts`, would serve both humans reviewing output
  (#29, "read the output yourself") and agents.

## Proposed data model

This is a sketch to feed #28, not a final schema. Time columns follow the
existing `secondsInterval()` convention.

```ts
chaptersTable = pgTable(
  "chapters",
  {
    id: serial().primaryKey(),
    meeting_id: integer()
      .notNull()
      .references(() => meetingsTable.id),
    start_secs: secondsInterval().notNull(),
    end_secs: secondsInterval().notNull(), // explicit: gaps are legal (#25); must be > start_secs
    kind: chapterKind().notNull(), // enum, see Chapter kinds
    title: varchar().notNull(), // a few words, TOC-scannable
    summary: varchar().notNull(), // one sentence: tooltip, collapsed row, agent outline
    bullets: varchar().array().notNull(), // text[]; 3–7 for discussion and report, 0–1 otherwise; no timestamps
    // Not in v0: an agenda link (eg "7.b", later a foreign key to agenda_items)
    // would go here when nesting arrives.
    // provenance (#28): which run produced this row
    generation_id: integer().references(() => chapterGenerationsTable.id),
  },
  (table) => [
    // A chapter has positive length: end_secs is strictly after start_secs.
    check(
      "chapters_end_after_start",
      sql`${table.end_secs} > ${table.start_secs}`,
    ),
    // No overlap per meeting: an exclusion constraint or an app check (#29).
  ],
);

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

`chapterKind` is the enum of the six kinds in
[Chapter kinds](#chapter-kinds).

Notes on reconciling with existing tickets:

- **#25 / #28, gaps:** kept legal. The generator covers the meeting (see
  [Coverage](#coverage-chapters-cover-the-whole-meeting)), and the schema
  doesn't enforce it.
- **#28, bullets:** `text[]`, the native Postgres type for a list of strings.
  The database enforces that every element is a string, and full-text search
  over it is simple. `jsonb` was considered only to match `segments.words`,
  which holds objects, not strings. Bullets never get timestamps (see
  [Granularity](#granularity)), so they never need to become objects.
- **#28, provenance and regeneration:** a separate generations table lets
  regeneration create a new generation and swap which one is current, rather
  than versioning each row. A fingerprint of the rendered transcript makes
  staleness detectable. That covers "invalidation on re-transcription" from
  #25. A new speaker _label_ doesn't stale a chapter because speakers are
  derived, but a changed transcript does.
- **#29, validation:** ordered, non-overlapping, in-bounds, and 1 to 15 minutes
  for `discussion` and `report` only. Also check coverage: flag uncovered speech longer than about
  30 seconds.
- **#27, gold:** write the gold chaptering with the same `kind`s, so deliberate
  gaps become explicit `procedural` or `break` entries.
- **#33, UI:** the placement, active-chapter, and bullets questions are
  answered above (tabs, binary search with a gap state, bullets expanded on the
  active chapter). The scrubber and transcript dividers go beyond #33's scope
  and may deserve their own ticket.

## Not in v0

These are deliberately out of scope for the first version:

- **Timestamps on bullets.** Bullets summarize a whole chapter and are not
  tied to a moment. See [Granularity](#granularity).
- **A human edit UI** for chapter boundaries and titles. Any corrections in v0
  go through the CLI or the database.
- **Export** to Podcasting 2.0 JSON chapters or YouTube description
  timestamps. It would be cheap, and YouTube-format chapters could be offered
  back to the bodies that publish the videos, so it is a possible follow-up.
- **Nesting and an agenda link.** See
  [No nesting in v0](#coverage-chapters-cover-the-whole-meeting).

## Open questions

1. **Kind set details.** Should `executive_session` be its own kind rather
   than a `break`, so closed sessions can be counted across meetings? Should
   Q&A get its own kind, as on citymeetings, if Anchorage committee meetings
   turn out to be question-heavy? Should `vote` chapters carry an outcome
   (passed, failed, withdrawn) and a tally, as Legistar and CDP do? For now
   that would be a placeholder comment in the schema, like the agenda link.
