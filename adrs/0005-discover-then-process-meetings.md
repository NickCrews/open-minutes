# ADR 0005: Discover meetings on a schedule, process each one separately, and record every processing run

Date: 2026-10-03
Status: Proposed

## Context

Until now a meeting got into the database one way: someone ran `om ingest
<video id>`, which downloaded, transcribed, diarized, aligned and recognized
it, then inserted the meeting row and its segments in one transaction. A
meeting row existing meant "fully ingested", and nothing recorded how it had
been made.

We want new meetings to show up without anyone running anything: a scheduled
job notices new videos on each body's channels and playlists, and the slow
work (tens of minutes of CPU per meeting, more once chapters and summaries are generated)
happens per meeting, asynchronously, where one meeting failing doesn't hold
up the rest.

We also want to know, when the logic changes, which meetings to redo. A new
recognizer model, a new cleaning rule, a better chapter prompt: each makes
the meetings processed before it out of date, and today nothing says which
those are. Chapters already record this for themselves
(`chapter_generations`: model, prompt version, transcript fingerprint); the
transcript records nothing.

## Decision

### A meeting exists from discovery, before it is processed

**Discovery** (`om discover`) scrapes every body's video sources and records
each video that isn't a meeting yet as one, with what the listing says (title,
duration, the date in its title) and the body whose source listed it. It needs
nothing from YouTube but the listing, which works from datacenter IPs.

Attributing a meeting to the source that listed it, rather than to whichever
body has the video's channel as a source (what `om ingest` still does for a
video it is handed), is what the schema always intended for bodies that share
a channel and are separated by playlist.

A meeting row no longer implies a transcript. The web shows only meetings that
have segments, so readers never see an empty one.

### Processing is a list of steps, each recorded as runs

A meeting goes through **processing steps**, each named for what it makes:
`transcript`, then `chapters` and `summary`, which are made from the
transcript. Only `transcript` is built; the schema and the state rules
already cover the other two, which join the step list in
`packages/pipeline/src/om/steps.ts` when their generation is built (#29).

Every attempt at a step is a row in `processing_runs`: meeting, step, the
step's version in the code that ran it, status (`running`, then `succeeded` or
`failed`), start and finish times, the error, the GitHub Actions run URL, and
step-specific details (the commit, the models and cleaning rules, segment
count, transcript fingerprint). Runs are append-only: reprocessing adds a run;
the table is the audit trail. The `meeting_processing` view gives each
meeting's latest successful run per step: when it was last transcribed (or
chaptered, or summarized), and by which version.

A step's output and its run's success commit in one transaction, so a meeting
never has a transcript without the run that made it, or the reverse.

### A step's state is derived from its runs

`stepState` (in `packages/pipeline/src/om/runs.ts`) derives where a step
stands for a meeting, from that meeting's runs:

| State     | When                                                                            | Run by the sweep? |
| --------- | ------------------------------------------------------------------------------- | ----------------- |
| `pending` | never succeeded                                                                 | yes               |
| `running` | a run started less than 6 hours ago and hasn't finished                         | no                |
| `blocked` | a step it is made from hasn't succeeded                                         | no                |
| `failed`  | never succeeded, and failed 3 times at the current version                      | no; by hand, yes  |
| `done`    | succeeded at the current version, after the steps it is made from               | no                |
| `stale`   | succeeded, but at an older version, or before a step it is made from was redone | only when asked   |

A run still `running` after 6 hours is taken as abandoned (a runner killed at
its timeout never records its failure), so the step can be picked up again.

### Versions are explicit and bumped by hand

Each step has a version string in code (`TRANSCRIPT_VERSION`), bumped whenever
a change would make the step write something different for the same input.
A test pins the transcript version together with the models and cleaning rules
it can see, so changing those without bumping it fails; changes it can't see
(a threshold, the alignment) rely on review.

We chose hand-bumped versions over a hash of the code or the commit SHA: a hash
changes on every refactor, marking everything stale for changes that make no
difference, while a version names the changes that do. The commit is still
recorded on every run, for audits.

Two versions are special:

- **`human`**: made or verified by a person (the golden transcripts). Never
  stale: a pipeline run would be a downgrade.
- **`untracked`**: made before runs were recorded. The migration that adds
  `processing_runs` gives every meeting that already had segments one
  succeeded `untracked` transcript run, so those meetings read as done but
  stale, rather than as never transcribed.

### Stale output is listed, not redone automatically

The scheduled sweep only runs `pending` steps. Stale ones are reported
(`om status`) and redone only on request (`om pending --stale`,
`om process --stale`, or the `stale` input of either workflow). Reprocessing a
transcript replaces its segments, which discards hand edits to them (splits,
merges, corrected words); recognition does carry speaker identities over, by
voice. So redoing a meeting is a decision, not a side effect of deploying.

### The schedule is GitHub Actions

- **`discover-meetings.yml`** runs twice a day: `om discover`, then
  `om pending --limit N`, then for each of those meetings it dispatches
  `fetch-youtube-audio.yml` (if the object store lacks the audio) and
  `process-meeting.yml`.
- **`process-meeting.yml`** processes one meeting (`om process <id>`), in its
  own job, with a concurrency group per meeting.

Both check out the `production` branch, so the code that writes production
matches its schema, and both are opt-in on the same Neon secrets as deploys.
The limit keeps a large backlog (a new body's whole channel) from flooding the
runners and YouTube; the rest wait for later sweeps.

GitHub Actions already runs the audio fetch, holds the secrets, and gives each
meeting a log page that its runs link to. A queue service, or a long-running
worker, would add infrastructure for no gain at a few meetings a day.

## Consequences

- `om ingest` still works for one video by hand: it records the meeting if
  needed, then processes it.
- A failed meeting stays in the database with its failed runs, and is retried
  by the next sweeps until it has failed 3 times at the current version.
- The `chapters` and `summary` steps, when built, must treat human-reviewed
  chapters as `human` runs, or a sweep would overwrite them.
- Old anonymous people are not cleaned up when a transcript is redone; in
  practice recognition matches the same voices to the same people.
