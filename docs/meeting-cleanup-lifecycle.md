# Meeting cleanup lifecycle

Status: proposed. This doc records why meeting cleanup works the way it does
and the rules it follows. It deliberately leaves out how: the harness, the
tool formats and the file layout belong in an implementation spec, written
once this doc is settled. If the two disagree, change this doc first.

## The problem

Ingestion makes mistakes that only judgement can fix. Diarization folds short
interjections into the chair's segments and splits one voice into two
clusters. Recognition attaches a speaker to the wrong person, or creates a
new anonymous person for someone it has heard before. Transcription mishears
names and places ("good wood" for Girdwood), drops roll-call answers and
seconds, and invents words over silence. Ingestion can't supply some data at
all, such as the meeting date. The [transcript-cleanup
skill](../.claude/skills/transcript-cleanup/SKILL.md) describes these
mistakes and the evidence needed to fix them.

We want agents to fix them, every day, across every meeting, without a person
watching each run. We also want them to do it with the same skills, tools and
habits a developer uses when cleaning a meeting by hand, so improving one
improves the other.

Three things make this harder than letting an agent loose on the database:

- **Production keeps changing underneath the agent.** A meeting can be
  re-ingested, a human can correct it, or another agent can work on it while
  a cleanup is in progress. A change worked out against yesterday's state must
  not silently overwrite today's.
- **The mistakes that matter most are the hardest to see.** Attributing words
  to a named, real person on a public website is a claim about them. A wrong
  relabel looks just as tidy as a right one.
- **Meeting speech is untrusted input.** Anyone can say anything during public
  comment, including text written to steer an agent. Whatever the agent
  reads, it must not be able to do more damage than its task allows.

## Convictions

### 1. Agents edit files, not the database

A cleanup agent works on plain-text copies of the meeting it was given: its
transcript as [PSV](../adrs/0001-psv-golden-transcript-format.md), its people,
its chapters and its metadata. It may change them however it likes: with
`psvtool`, a script, or by hand. It never writes to a database. It may read
any of the database with SQL, read-only.

This is the middle ground between two failure modes:

- **Only typed tools.** Giving the agent one tool per kind of edit means we
  have to anticipate every edit in advance. We already haven't: the skill
  asks the agent to fix misheard words, and no tool does that. Every missing
  tool caps what the agent can do.
- **Raw SQL, then diff the database.** This is maximally flexible, but the
  diff is in the wrong medium:
  - A row diff shows a split as an updated jsonb array of hundreds of words
    plus an inserted row. A reviewer can't see what changed.
  - New rows take ids from the scratch database's sequences, which collide
    with production's, so the diff can't be applied as is.
  - Rows carry no record of what they were changed from, so applying a row
    diff overwrites whatever production holds now.
  - Most of what makes a meeting valid isn't enforced by the database:
    segments that don't interleave, words in onset order, people-records
    conventions, voiceprints that match their segments.

Files keep the flexibility and fix the diff. PSV was already designed so that
a small change makes a small, readable git diff (ADR 0001). Every line starts
with an onset, so no two lines are alike, and diffs and merges line up
cleanly. A cleaned meeting is in the same format as a golden transcript, so
cleanup output can become test data.

### 2. One task, one meeting

A **meeting task** may edit one meeting: its transcript, chapters and
metadata, including which existing person each segment is by. A meeting is
already the natural unit for everything else here:

- **Divergence.** A whole meeting is what gets merged or rejected.
- **Review.** One meeting makes one diff.
- **Context.** A meeting of about 27k words fits in an agent's context.
- **Failure.** A bad run damages one meeting.
- **Concurrency.** Meetings run in parallel, and claiming one is trivial.

Reading is not scoped. The evidence for a fix often lives in another meeting:
an anonymous person introduced themselves in March, or the roll-call order
comes from last month's minutes.

People are the exception to the meeting boundary. Naming, merging or splitting
a person changes every meeting they speak in, and none of that shows up in one
meeting's diff. So those edits belong to a **person task**, whose reviewer
sees every meeting the person appears in.

When an agent finds work outside its task ("person 812 is probably person
640", "Cruz is misheard in five other meetings"), it doesn't do that work.
It returns it as a **follow-up**, which becomes a task of its own.

The harness enforces the scope, not the prompt. A task's writable files are
the only things it can change, and its database access is read-only.

### 3. A proposal is a diff, reviewed as a transcript

What an agent proposes is the set of changes between the files it was given
and the files it leaves. The PSV diff is what gets stored, merged and
applied. It is not what a reviewer reads. The raw diff of one word fix, one
relabel and one boundary moved three words later:

```diff
-0:00:42.97|meta|{"begin_speaker":"identified:jennifer-wingard"}
+0:00:42.97|meta|{"begin_speaker":"segmented:spk-5"}
...
-0:01:20.53|text|Traditional,
+0:01:20.53|text|Brian,
...
-0:01:22.41|meta|{"begin_speaker":"identified:brian-burnett"}
 0:01:22.41|text|I
 0:01:22.54|text|would
 0:01:22.76|text|be
+0:01:22.88|meta|{"begin_speaker":"identified:brian-burnett"}
```

It's correct but hard to judge:

- A relabel doesn't show how much speech it covers.
- Two lines of context is two words, so "Brian," has no sentence around it.
- A moved boundary looks like a marker jumping, not like words changing
  speaker.

The same change, rendered as a transcript and word-diffed:

```
=== [-identified:jennifer-wingard-]{+segmented:spk-5+} | 0:00:42.97-0:00:43.25 | 3 words
[0:00:42.97] no your turn

=== identified:mike-edgington | [-0:00:44.69-0:01:21.95-]{+0:00:44.69-0:01:22.76+} | [-89-]{+92+} words
[0:01:20.53] [-Traditional,-]{+Brian,+} would you like to do the land acknowledgement?
{+[0:01:22.41] I would be+}

=== identified:brian-burnett | [-0:01:22.41-0:01:50.85-]{+0:01:22.88-0:01:50.85+} | [-82-]{+79+} words
[-[0:01:22.41] I would be-]{+[0:01:22.88]+} glad to So the Girdwood Board of Supervisors acknowledges…
```

So reviewers, agent or human, read the rendered transcript diff. A change to a
person also lists every other meeting it affects, because no transcript diff
can show that.

### 4. Edits stand on their own

The agent doesn't have to justify each edit in a structured format. Most
edits are obviously right or wrong once you see them in context: a relabel
right after the chair says "Yes, Brian." needs no note. Some don't show their
reasons, such as a roll-call answer placed by elimination, a name taken from
the minutes, or a word recovered by listening to the audio. For those, the
agent adds a short note in plain text so the reviewer doesn't have to redo
the work. A note is optional; an edit that needs a long argument is probably
not one to make.

### 5. A second agent reviews, and the loop is bounded

A reviewer agent sees the task, the rendered diff, the original files and the
same read-only tools as the author, including the audio. It doesn't see the
author's reasoning, so it judges the edits rather than the argument for them.
A different model or prompt for the reviewer makes shared blind spots less
likely.

The reviewer accepts or rejects each change separately, so one disputed
relabel doesn't hold back forty good word fixes. The author may revise or
answer. After a fixed number of rounds, the agreed changes go ahead and the
rest becomes follow-ups or flags for a human.

The reviewer is the guard against the second and third problems above: wrong
attributions that look tidy, and agents steered by what they read. It is not
infallible, so some edits need a human. Which edits those are (perhaps
merging people, or naming a person for the first time) is an open question.

### 6. Applying is code, not an agent

Once a proposal is accepted, deterministic code applies it:

1. Export the meeting from production as it is now.
2. Three-way merge: the export the agent started from, the agent's files, and
   production's current export.
3. Validate the result with the same checks the agent ran.
4. Write the meeting in one transaction.

If the merge conflicts or the result is invalid, nothing is written and the
meeting is queued again. A conflict only happens when production changed
the same words as the agent, and then redoing the cleanup from fresh data is
the right answer anyway. This is how divergence is handled: no locks held
for the length of a run, and no guessing at merges.

### 7. Human corrections are durable; everything else can be rederived

Production data comes from three sources:

- **Ingestion**, from audio. Can be rerun.
- **Agent cleanup**, from ingestion plus judgement. Can be rerun, at a cost.
- **Human corrections.** Cannot be regenerated.

So human corrections are recorded as the edits they were, anchored by onset,
and kept apart from the data they changed. When a meeting is re-ingested with
a better model, or cleaned again with a better skill, the agent gets the human
corrections for that meeting. It has to uphold what each one meant, even when
the words and segments under it have moved. We trust the agent to interpret
them, and check it mechanically: after a run, every human correction whose
literal effect no longer holds (these words are no longer Brian's, that word is
no longer "Brian,") is shown to the reviewer first.

We don't keep an audit trail of agent edits. If an agent gets something wrong,
the fix is to correct the skill or the harness and rederive. Traces of every
agent run go to an observability tool for debugging. Evals on golden meetings,
run before any change to a skill, catch regressions.

### 8. Same setup as development

The cleanup agent uses the repository's skills, its `psvtool`, its checks and
its audio tools, the same as a developer cleaning a golden meeting. The
automated job adds a harness around them: scope, read-only database access,
the review loop and the apply step. It doesn't add a second set of tools.
Improving the skill for a developer improves the job.

## The lifecycle

```
pick work ─▶ export ─▶ author ⇄ reviewer ─▶ apply ─▶ follow-ups
             files      edits    reads        3-way    queued as
             + base     files    rendered     merge    new tasks
             snapshot             diff        + check
                                     │           │
                                     ▼           ▼
                                  flags for   conflict:
                                  a human     queue again
```

1. **Pick work.** A meeting with known problems, a new meeting, a meeting
   whose human corrections or skill changed, or a follow-up.
2. **Export.** The task's files, as production holds them, kept as the base
   for the merge.
3. **Author.** An agent edits the files, using read-only SQL and the audio
   tools, and validates as it goes.
4. **Review.** A second agent reads the rendered diff and accepts or rejects
   each change, for up to a fixed number of rounds.
5. **Apply.** Code merges, validates and writes, or queues the task again.
6. **Follow up.** Out-of-scope findings become new tasks. Unresolved doubts
   become flags for a human.

## What the files must be able to express

An agent only edits files, so the files must be able to express every edit
an agent might need. The list below sets that requirement. It does not list
tools to build.

**Who said what.** Attribute a stretch of words to a different speaker. This
one edit covers relabelling whole segments, moving a boundary a few words,
pulling an interjection ("So moved.", "Second.", a roll-call "Here.") out of
the chair's segment, and marking speech unattributed. It also covers
relabelling a whole speaker number at once. Splitting a segment where the
speaker doesn't change, and joining two segments into one, are the only other
edits to segments.

**Words.** Replace a stretch of words: fix a mishearing, insert dropped words
recovered from the audio, delete invented words. Replacing a misspelling
everywhere in a meeting is many of these.

**People.** Name an anonymous person, or set their slug and bio. Create a
known person. Merge two people who are one voice. Split one person who is two
voices across meetings. Rebuild a voiceprint from segments known to be the
person's. Rename a slug. All of these are person-task edits except
attributing words to an existing person.

Rebuilding a voiceprint matters more than it looks: recognition matches
every future meeting against it, so a wrong one spreads.

**Chapters.** Replace them, edit one chapter's text, move a boundary, mark
them reviewed by a human.

**Meeting.** Set the date, time and title. Hide a duplicate, or a video that
isn't a meeting.

**Outputs that aren't edits.** Flags ("this speaker number may be two voices;
it needs a human"), follow-ups, and a record that something was looked at and
left alone. Without that record, a daily job spends tokens rereading the
same unresolvable speakers every day.

Some of these can't be expressed today. There is no database tool to edit
words. A person can't exist without a voiceprint, so someone named in the
minutes who spoke once can't be created. A meeting can't be hidden.

## Alternatives considered

- **The agent writes straight to production.** There's no review, the agent
  holds production credentials, and meeting speech goes straight into it.
- **The agent works on the nightly DuckDB export and returns JSON.** The
  export is up to a day stale, and the tools run on Postgres, so each tool
  would need a second implementation.
- **The agent works on a Neon branch that is merged back.** Neon doesn't
  merge branches. Merging rows by hand runs into every problem with row
  diffs described under conviction 1.
- **Typed operations as the only way to edit.** This is safe and replayable,
  but it caps the agent at the tools we thought of. Typed operations may
  still be how the apply step expresses a merged diff internally.
- **Suggestions stored in production and accepted in the web UI.** Worth it
  once people other than the maintainer review edits. Until then it's more UI
  than it's worth.
- **Structured evidence on every edit, and an audit log of agent edits.** See
  convictions 4 and 7.

## Open questions

- Which edits need a human, not just the reviewer agent?
- How are human corrections captured: from the web UI, from a developer's
  local edits, or both? And in what form?
- How many review rounds, and what happens to a change still disputed at the
  end?
- Should a person task run before or after the meeting tasks it affects?
- Which new terms (task, proposal, follow-up, flag, human correction) belong
  in [TERMINOLOGY.md](../TERMINOLOGY.md)?
- Does anything depend on segment ids staying the same? Applying a merged
  meeting may replace its segments rather than update them in place.

## Not in this doc

The implementation spec, to be written from this doc, covers:

- the harness and how a task runs,
- the file layout of a task and the export and import between files and the
  database,
- the renderer for the review diff,
- the merge and apply step,
- the format of human corrections, flags and follow-ups,
- scheduling, and the observability setup.

## Left out: ideas to sort

These came up while working this out and didn't make it into the sections
above, either because they're implementation detail or because no decision
was made on them. Move each one into a section above, save it for the
implementation spec, or delete it.

### Safety and limits

- **Blast-radius limits.** Cap each run's meetings, edits, tokens and wall
  time. A run that wants to relabel 400 segments should stop and ask a human
  rather than propose them.
- **Credentials.** The agent's database role can only read. Only the apply
  step holds production write credentials.
- **Prompt injection is concrete.** Someone can say "ignore previous
  instructions" during public comment, and it will be in the transcript word
  for word. Scope, read-only access and the reviewer are the defence, not the
  prompt.
- **Risk tiers.** For example:
  - _Apply without review:_ fixing a misheard place name, or a split confirmed
    by a roll call.
  - _Needs the reviewer agent:_ relabelling to an existing person, or
    replacing chapters.
  - _Needs a human:_ merging people, naming a person for the first time,
    editing a bio.

  A tier for edits applied without review only makes sense once acceptance
  rates show it's safe.

- **Human decisions win.** An agent never overwrites a human correction. It
  can only flag a disagreement for a person to settle. Conviction 7 says the
  agent "upholds the intent" of a human correction; this would make the rule
  stricter.

### Divergence

- **Claiming a meeting.** A row with an expiry time, so two runs, or a run and
  a human, don't work on the same meeting at once. The three-way merge
  already keeps the data correct without it; claiming only saves wasted
  work.
- **A revision number per meeting.** A `meetings.revision` column that goes up
  on every write, with apply refusing when it has changed. It's simpler than
  a three-way merge but coarser: any change anywhere in the meeting causes a
  conflict.
- **Re-ingesting moves onsets.** Re-transcription shifts word onsets, which
  changes every PSV line. So a proposal made before a re-ingest will always
  conflict, and human corrections can't be replayed line by line afterwards.
  That's the reason conviction 7 hands them to an agent to reinterpret,
  rather than replaying them mechanically.

### Edit format

- **Address edits by word, not segment id.** A word reference is its onset
  plus its text, eg `{ at: "0:41:12.30", text: "Brian" }`, and a span is two
  of them. Segment ids change with every split and merge, and differ between
  databases.
- **Four edits cover the transcript.** Attributing a span to a speaker,
  splitting at a word, joining at a word, and replacing a span of words cover
  every transcript edit in [What the files must be able to
  express](#what-the-files-must-be-able-to-express). Each edit can carry an
  `expect` field (what it should find there first) as its check against
  divergence.
- **Turning a diff into typed edits.** Every word has an onset, so a PSV diff
  can be translated automatically into those four edits. The agent keeps
  free-form file editing, and the apply step still gets checked, typed edits.
- **Escape hatch.** Allow a `sql_patch` edit that always needs a human. Log
  every "I needed an edit that doesn't exist" from agents, so we build the
  next tool on demand rather than guessing.
- **Requesting reprocessing.** Some problems need the pipeline, not an edit
  (re-transcribe this stretch, re-diarize this meeting). The agent should be
  able to ask for that as an output.
- **Voiceprints when merging people.** Keep the surviving person's
  voiceprint, or recompute it from both people's segments? Today
  `merge_people` keeps it.

### Review

- **The reviewer keeps its context across rounds**, so it can check its
  requests were addressed. The author can reply, but it can't argue
  indefinitely.
- **Renderer details.** Drop segment numbers from the rendered transcript,
  since a split renumbers every later segment and makes the diff noisy. Show
  names next to slugs. Put the people diff next to the transcript diff.
- **The PR as the proposal.** Each proposal could be a pull request: its edits
  committed as files, a summary of the changes in the body, the reviewer
  agent's verdict as a PR review, and merging triggers the apply step.
  `pr-preview.yml` already gives each PR a Neon branch and a preview of the
  website, so a person could look at the cleaned meeting before merging.
  This gives review, discussion and history for free. The cost is a PR for
  every proposal.

### Learning from runs

- **Rerunning has a cost.** Rerunning the agent costs money on every meeting,
  and because it's nondeterministic it can change meetings that were already
  fine. Rerun a meeting only when one of its inputs changed: ingestion, human
  corrections, or the skill.
- **Record what was looked at and left alone, keyed by skill version.** Then a
  daily run skips what it has already judged, until the skill changes.
- **Closing the loop:**
  - Rejected edits and human reverts become candidate eval cases.
  - Well-cleaned meetings become new golden meetings.
  - Evals run the agent on golden meetings with their labels removed and
    score it against the golden transcript.
- **Metrics to watch, per skill version:**
  - how often the reviewer accepts an agent's edits,
  - how often humans revert them,
  - how many problems `check_meeting` reports per meeting.

### Harness

- **Headless Claude Code is one option.** Run `claude -p` with the
  repository's skills, a separate settings file for this job that allows only
  the cleanup commands, and a PreToolUse hook to enforce scope. The other
  options discussed: pi, Cloudflare, or a just-bash sandbox with read, write,
  CRUD tools and `queryDb`.
- **Traces.** Claude Code can export OpenTelemetry. Keep the transcripts of
  both agents, the diff, the reviewer's verdicts and the result of applying,
  all keyed by run.
- **No database branch needed.** The agent never writes to a database, so
  it can read production, or a replica or snapshot, directly. A Neon branch
  only helps if the agent needs to run checks that exist only in SQL.
- **Context budget.** A golden transcript is about 24k lines. The agent should
  use `render`, `grep` and `get_transcript` ranges, not read the whole file.
- **Reads can use DuckDB.** The nightly DuckDB export is fine for broad
  exploratory queries that don't need today's data.
