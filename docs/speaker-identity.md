# Speaker identity: recognition, naming, and correcting mistakes

Status: design notes and proposals, not built. Builds on
[ADR 0002](../adrs/0002-two-tier-speaker-identity.md) (speakers are local to a
meeting, people are global) and uses the words in
[TERMINOLOGY.md](../TERMINOLOGY.md). Where this doc proposes a new term, it
says so.

## The problem that started this

Today, ingestion runs recognition on each speaker: it takes the speaker's
voice embedding, finds the nearest person's voiceprint, and links the speaker
to that person if they're close enough. If nobody is close enough, it creates
a new anonymous person (`packages/ingest/src/identify.ts`). The link is
written straight onto each segment as `person_id`.

That means a person row is a _claim that every segment pointing at it is the
same individual_, and the claim is made by a cosine-distance threshold alone.
Naming the person later spreads the name to every one of those segments in
every meeting.

The scenario:

1. Meeting A: recognition creates anonymous person P from speaker 3.
2. Meeting B: speaker 5 matches P. In meeting B, the chair says "Thank you,
   John" just before speaker 5 talks, so someone names P "John Doe".
3. Meeting A's speaker 3 now shows as John Doe. But meeting A's roll call
   says John Doe was absent.

So the link from meeting A's speaker 3 to P was wrong, or the roll call is
misleading, and nothing in the system notices either way. The two fixes
that came to mind:

- **Re-review meeting A** now that we know more.
- **Don't create a global person until we know who it is**: keep the voice
  local to meeting A, and only link it across meetings when we're sure.

Both are partly right. The root problem is that the system stores the output
of recognition (a guess) in the same place, and with the same weight, as a
human's or an agent's identification backed by evidence (a fact with a
source). Naming a person then turns every guess attached to it into a public
claim without anyone looking.

## Proposal in one paragraph

Store each meeting's speakers as rows with their own voice embeddings. Link a
speaker to a person through an **attribution** that records how we know
(recognition at some distance, or a human or agent quoting evidence) and
whether it's been confirmed or rejected. Show a name publicly only through a
confirmed attribution. When something changes what we know about a person
(they get named, merged, split, or their voiceprint changes), queue a review
of every meeting where that person has unconfirmed attributions, with the new
hypothesis spelled out ("speaker 3 may be John Doe"). Rejections are kept, so
recognition never proposes the same wrong link again. Voiceprints are built
only from confirmed speakers, so one bad guess can't pull in more.

The rest of this doc explains why, lists the tricky cases this has to handle,
and sketches the data model and the agent process.

## Answering the two options directly

### Option 1: re-review meeting A

This is the right instinct, and in the proposal it's the normal path:
naming P creates a review task for meeting A. The cleanup agent gets a
narrow question ("is speaker 3 John Doe? recognition says yes at distance
0.38; John Doe was confirmed in meeting B by 'Thank you, John'"). It checks
meeting A's own evidence: the roll call, the official minutes, whether
anyone addresses speaker 3 by name. It finds the roll call and either:

- **rejects** the attribution. Speaker 3 goes back to having no person (or
  gets a new anonymous person, see below). The rejection is stored, so
  re-running recognition doesn't re-link them. John Doe's voiceprint doesn't
  include meeting A's audio, because it was never confirmed.
- or **confirms** it with a note, if the roll call turns out not to be
  conclusive. See [Absent at roll call doesn't mean silent](#absent-at-roll-call-doesnt-mean-silent).

What makes this workable rather than expensive is that the review is
targeted. The agent re-checks one speaker against one hypothesis, not the
whole transcript.

What makes it _safe_ is that, until the review happens, meeting A doesn't
show "John Doe". It shows a placeholder name, maybe with a hint ("possibly
John Doe"). Naming someone never silently rewrites another meeting's
public transcript.

### Option 2: don't create global people from voice alone

Also partly right. There are real reasons to keep an anonymous person:

- Recurrence is the signal that makes someone worth naming. A voice heard in
  ten meetings is probably a staffer or a regular public commenter, and
  that's worth surfacing to a human even before anyone knows who it is.
- Without a cross-meeting link, step 2 of the scenario (naming P in meeting
  B fills in the name in meeting C, where it's correct) never happens.

But creating a person for _every_ unmatched speaker at ingest is too eager.
Most of them are one-off public commenters, a presenter who comes once,
music, or a cluster that mixes several voices. Each becomes a person row
with a voiceprint that future meetings match against. That clutters the
people table and adds false matches.

The middle path: **a speaker doesn't need a person.** Every speaker keeps its
embedding on its own row. Recognition matches a new speaker against two
pools:

1. people's voiceprints, as today, and
2. _unlinked speakers from earlier meetings_.

A match in pool 2 is when a voice first recurs, and only then does recognition
create an anonymous person, attributing both speakers to it. A voice heard
once stays local. A person exists because a voice recurs or because someone
identified them, never just because a cluster existed.

Separately, whether an anonymous person's cross-meeting link is _shown
publicly_ is a policy question (see [Privacy](#privacy-linking-private-citizens-across-meetings)).
Today's placeholder names ("Anonymous Heron") are per-meeting and never
stored, which already hides the link from readers. Keep that.

## Tricky situations

A brainstorm of the cases the data model and the agents will hit, grouped
roughly by cause. Each one says what it implies for the design.

### Naming and evidence

#### Retroactive naming contradicted by local evidence

The scenario above. Implies: attributions carry a status, naming triggers
review of unconfirmed attributions, and rejections are stored.

#### Absent at roll call doesn't mean silent

Roll call is taken once, at the start. People arrive late ("Let the record
show Mr. Doe has joined us"), call in partway through, or speak during public
comment as a private citizen at a meeting of a body they don't sit on. The
minutes may list someone as absent and also record them speaking. Evidence
has a strength, and absence is weak evidence about the whole meeting but
strong evidence about the minutes around the roll call. Implies: the agent
reports evidence with its scope ("absent at roll call at 0:02:10"), and a
rejection based on absence needs no contradicting evidence later in the
meeting.

#### Is a voice match evidence?

The cleanup skill's rule 1 lists what counts as evidence, and voice
similarity isn't on it. It should be on it, but weaker than in-meeting evidence.
A very close match to a person with many confirmed meetings is strong. A
borderline match to a person confirmed once is a hint. Proposed rule:
recognition alone can _propose_ an attribution, never confirm one, except
above a strict threshold _and_ against a person with at least N confirmed
speakers _and_ with no contradicting evidence in the meeting. Everything else
needs in-meeting evidence. N and the threshold are tuned on the goldens.

#### Self-reinforcing mistakes

If meeting B's naming is wrong, the wrong name spreads as hypotheses to
other meetings. An agent reviewing those meetings sees "recognition says this
is John Doe" and, lacking contradicting evidence, confirms it. Now three
meetings "confirm" a wrong identity, and the voiceprint is built from all
three. Implies:

- Confirmation needs positive in-meeting evidence (or the strict voice-only
  rule above), not just absence of contradiction.
- Each attribution records what it was confirmed _by_, so when the source is
  retracted, the ones that depended on it can be found and reopened.
- Agents see the hypothesis but should look for evidence before reading
  recognition's opinion. Present the question as "who is speaker 3?" with
  recognition's guess as one input, not "confirm that speaker 3 is John".

#### Two speakers in one meeting both named John Doe

Sometimes legitimate: diarization splits one person into two clusters (they
moved from the dais to the podium, or switched from room mic to phone). Sometimes
wrong: two people the agent confused. Implies: allow it, but have
`check_meeting` warn when two speakers attributed to one person _talk over
each other_, which one person can't do.

#### The name refers to someone else with the same name

Two John Does in a city: a father and son, or a council member and an
unrelated public commenter. "Thank you, John" picks among every John.
Implies: the slug is the key, never the name (already true). Name evidence
picks among people _who plausibly attend this body_, and voice similarity
is a tie-breaker. The agent should ask rather than guess when two known
people share a first name and the voice doesn't decide it.

#### Name changes, nicknames, misspellings

Someone marries and changes their surname; "Mike" in the room is "Michael" on the
roster; speech recognition hears "Cruz" for "Crews". Implies: a person's
known aliases are useful evidence for matching names in transcripts. Store
them (an `aliases` list, or prose in the bio for now), and match names
loosely (cleanup rule 2 already says this).

#### Roles aren't people

"Madam Chair", "the clerk", "Chief" identify a role, and who holds the role
changes. An agent seeing "Thank you, Madam Chair" in 2024 and 2026 must not
assume it's the same person. Implies: roles with dates in the bio (the
people-records skill already requires this), and a way for the agent to look
up who held a role on a meeting date. A per-body roster with terms would
answer that directly. See [Roster and attendance](#roster-and-attendance).

#### Someone reads another person's words

The clerk reads written testimony from Jane Smith into the record; a member
reads a letter from a constituent; a video clip plays. The _voice_ is the
clerk's but the _words_ are Jane's. Implies: the speaker attribution is
always the voice. "Reading a letter from Jane Smith" belongs in the
transcript text or a chapter, not the speaker label. Don't let a name
mentioned at the start of a reading become an identification. A recorded
clip or video played in the meeting is a voice that isn't in the room; the
speaker can be attributed to the person in the clip only with evidence, and
its embedding shouldn't feed their voiceprint, since it came through a
different channel.

### Voice and recognition errors

#### Two people merged into one person

Two board members with similar voices, or one voice on a bad phone line,
match each other. Every meeting where either speaks attaches to one person.
Today there's `merge_people` but no inverse, and splitting is impossible
because segments only remember `person_id`. Implies: `split_person`, which
is only possible if each speaker keeps its own embedding and its own
attribution. Splitting is then re-clustering that person's confirmed and
unconfirmed speakers into two groups.

Signals that a person might be two people: high spread among their speakers'
embeddings, a speaker attributed to them in a meeting where another speaker is
confirmed as them and they talk over each other, or contradicting name
evidence across meetings.

#### One person split into several people

Phone vs room mic, a cold, a different venue's PA, years of aging.
Recognition creates a second anonymous person. `merge_people` handles this,
but the merged person still has "exactly one voiceprint" (first-wins), which
is far from half their speakers. Implies: a person's voiceprint is a _set_
of embeddings (one per confirmed speaker, or a few centroids), and
recognition matches against the nearest member. This changes the term
"Voiceprint: each person has exactly one" in TERMINOLOGY.md.

#### A cluster holds several voices

The diarizer folds roll-call answers, "So moved." and "Second." into the
chair's cluster (cleanup rule 4). The cluster's embedding is mostly the
chair, so recognition attributes the whole cluster to the chair, including
other members' words. Implies:

- When cleanup splits out a voice, the split-out part becomes its own speaker
  in the meeting (a new speaker number, as goldens already do), so it gets
  its own attribution rather than inheriting the chair's.
- Embeddings for voiceprints should come from speech we're confident in, not a
  whole contaminated cluster. Once cleanup is done, recompute the speaker's
  embedding from its segments after the edit.

#### Voiceprint contamination

The voiceprint today comes from the first meeting the person was seen in and is
never recomputed (cleanup rule 10). If that first speaker was a mixed cluster
or a misattribution, every later match is skewed toward the wrong voice.
Implies: voiceprints are derived data, recomputed from confirmed speakers'
embeddings whenever an attribution is confirmed, rejected, or edited.

#### Threshold too loose or too tight

`MATCH_THRESHOLD = 0.55` auto-confirms what the source calls the "suggest"
band (0.55–0.70). With statuses, the bands can mean something: above 0.70,
propose with high confidence; 0.55–0.70, propose with low confidence; below,
no proposal. Measure the bands against the goldens before trusting them, and
expect them to differ between room mic and phone audio.

#### Ingest order changes the answer

Recognition is greedy and incremental: the first meeting ingested creates the
person, later ones match against it. Backfilling old meetings in a
different order produces different people. Implies: treat incremental
recognition as a fast first guess, and periodically re-cluster all unconfirmed
speakers globally (with confirmed attributions and stored rejections as
constraints). Recognition should be a function you can re-run, not a
one-way side effect of ingest.

#### Overlapping speech, crosstalk, applause

Short or noisy speakers have poor embeddings and match anything. Implies: don't
propose attributions for speakers with too little clean speech; record
`speaking_secs` on the speaker row and use it as a gate.

### Re-processing

#### Re-ingesting a meeting

A better speech model or diarizer means re-running a meeting, which rebuilds its
segments and speaker numbers. Every human or agent label hangs off the old
rows. Implies: confirmed attributions and their evidence must survive
re-ingest. Store the evidence with times (`0:14:32.10`, the quote), so
after re-ingest the new speaker covering that time can be re-attributed
automatically, the way `reapplySpeakerLayer()` already carries golden
labels across a re-transcription. Labels that can't be carried (the new
speaker boundaries disagree) become review tasks.

#### Human and agent edits fight

An agent confirms; a human later rejects; the next cleanup round the agent
re-confirms from the same evidence. Implies: every attribution records who made
it. An agent never overrides a human's decision on the same speaker; it
can only flag disagreement. Rejections are sticky for recognition and
agents alike.

#### Evidence that arrives later

Official minutes are often posted weeks after the meeting. They name movers,
seconders and public commenters, which settles many open questions. Implies:
"new minutes posted for meeting A" is a review trigger just like "person
named", and the review task carries what's new.

### Scope and policy

#### Privacy: linking private citizens across meetings

An official speaking at a public meeting is public. A resident who testifies
once is too, in that meeting. But _linking_ a private citizen's voice across
every meeting they've ever spoken at, without their name, is a kind of
tracking the transcripts alone don't enable. Implies:

- Keep today's rule: an anonymous person's cross-meeting link isn't shown
  publicly (placeholders differ per meeting).
- Decide whether to show a _name_ for a non-official by voice match alone, or
  only with in-meeting evidence (they said their name for the record that
  day). Leaning toward the latter.
- Support removal: someone asks to be unlinked or unnamed. Deleting their
  person row and rejecting its attributions has to work, and their
  speakers' embeddings shouldn't immediately re-create them.

#### Cross-body and cross-jurisdiction recognition

The same person testifies at the Assembly and at the Girdwood board, so
recognition should be global. But a global search over every voice ever heard
has many more near neighbours than a search within one body. Implies: use the
body as a prior. A match to someone who regularly attends this body needs
less evidence than a match to someone only ever heard in another
jurisdiction.

#### Goldens and the database disagree

Golden fixtures label people by slug (`identified:<slug>`) and are ground
truth, while the database collects agent edits. An agent confirming
"speaker 3 is John Doe" in a golden meeting in the database doesn't update
the PSV. Implies: either golden meetings are read-only in the database (all
edits go through the PSV and reseed), or there's an export path. Read-only
is simpler.

## Data model sketch

Changes from today, as a starting point for an ADR rather than a final schema.

### `meeting_speakers` (new)

The TERMINOLOGY.md "speaker", made into a row. One per speaker in a meeting.

| column            | notes                                               |
| ----------------- | --------------------------------------------------- |
| `id`              |                                                     |
| `meeting_id`      |                                                     |
| `speaker_number`  | unique within the meeting, as today                 |
| `voice_embedding` | nullable: null when there's too little clean speech |
| `speaking_secs`   | derived from segments, or stored at ingest          |

Segments replace `person_id` + `speaker_number` with
`meeting_speaker_id` (nullable for unattributed). Splitting a voice out of
a cluster creates a new `meeting_speakers` row.

### `speaker_attributions` (new)

A claim that a speaker is a person. Append-only history; the latest row
per (speaker, person) is its current state.

| column                     | notes                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `meeting_speaker_id`       |                                                                                            |
| `person_id`                |                                                                                            |
| `status`                   | `proposed`, `confirmed`, `rejected`                                                        |
| `source`                   | `recognition`, `agent`, `human`, `seed`                                                    |
| `distance`                 | for recognition: cosine distance to the person's voiceprint                                |
| `evidence`                 | for agent and human: quote and time, eg `"Thank you, John" at 0:14:32`                     |
| `depends_on`               | optional: the attribution this confirmation leaned on, so retracting one reopens the other |
| `created_by`, `created_at` |                                                                                            |

A speaker has at most one non-rejected attribution at a time. Rejected rows
stay as constraints: recognition never proposes a rejected pair again.

### `people`

- `voice_embedding` becomes derived: one or more centroids computed from
  embeddings of speakers with a confirmed attribution (or a separate
  `person_voiceprints` table with several rows). Anonymous people created
  by recurrence have only proposed attributions, so their voiceprint is
  computed from those until something is confirmed.
- Maybe `aliases` for name variants.

### Display rule

For each segment: follow `meeting_speaker` → current attribution.

- Confirmed, person named: show the name.
- Proposed, person named: show the placeholder, maybe with "possibly
  <name>" for logged-in reviewers or as a subtle hint.
- Anything else: placeholder for the speaker, or "Unknown" if unattributed.

This is the one rule that stops naming from silently spreading to other meetings.

### `review_tasks` (new)

| column               | notes                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `meeting_id`         |                                                                                                                 |
| `meeting_speaker_id` | optional: when the task is about one speaker                                                                    |
| `reason`             | `ingested`, `person_named`, `person_merged`, `person_split`, `voiceprint_changed`, `minutes_posted`, `conflict` |
| `hypothesis`         | eg "speaker 3 may be John Doe (person 41)"                                                                      |
| `status`             | `open`, `done`, `needs_human`                                                                                   |

### Roster and attendance

Two kinds of external fact that help a lot and don't exist yet:

- **Roster**: who held which seat or role on a body, with dates. Answers
  "who was chair on 2025-03-10?" and narrows name evidence to plausible
  people.
- **Meeting attendance**: per meeting, who the roll call or minutes record as
  present, absent, arriving late, or calling in, with the time. This is
  different from TERMINOLOGY's _attendance_ (which counts speaking), so it
  needs its own word, eg **roll** (proposed term). The agent records what it
  reads from roll calls here, and later reviews query it instead of
  re-reading the transcript.

Both could start as fields an agent fills in, with evidence quotes, like
attributions.

## Agent process sketch

1. **Ingest.** Diarize, compute and store each speaker's embedding. Recognition
   proposes attributions against voiceprints and against unlinked speakers
   from earlier meetings (creating an anonymous person on a first
   recurrence). Nothing is confirmed. Open a review task with reason
   `ingested`.
2. **Meeting cleanup** (one agent run per open task, today's
   transcript-cleanup skill extended). Fix segment boundaries and split mixed
   clusters first, since attributions depend on them. Read the roll call and
   minutes into the roll. Then for each speaker: gather in-meeting evidence,
   and confirm, reject, or leave proposed, with quotes. Name people only from
   evidence. Report what's left open.
3. **Propagate.** Each confirm, reject, name, merge, or split recomputes the
   affected voiceprints and opens targeted review tasks in other meetings
   where the person has proposed attributions, or where the voiceprint change
   moves a speaker across a threshold.
4. **Reconcile** (periodic, global). Re-cluster unconfirmed speakers. Look for
   conflicts: one person talking over themselves, a person confirmed in a
   meeting where the roll marks them absent with no later arrival, a person
   whose speakers' embeddings have high spread (maybe two people), two
   anonymous people with close voiceprints (maybe one). Each becomes a
   `conflict` review task.
5. **Humans** handle tasks marked `needs_human` and spot-check confirmations.
   A human decision is final for agents.

Steps 2 and 3 give option 1 from the top of this doc, targeted. The
recurrence rule in step 1 gives option 2's caution. The display rule keeps
either from showing a wrong name before a review has looked.

## Open questions

- **Voice-only confirmation.** Should a very strong match to a well-confirmed
  person ever be shown without in-meeting evidence? Without it, most
  meetings of a body show names only for people the chair happens to name.
  With it, a bad voiceprint names people silently. Measure on the goldens.
- **Show "possibly <name>" publicly?** Helpful to readers and invites
  corrections, but it's a public guess about a real person.
- **Granularity of attribution.** Per speaker (cluster) is simplest. Do we
  ever need per-segment attribution, or is "split it into its own speaker
  first" always enough?
- **How many voiceprints per person**, and how to pick them: all confirmed
  speakers' embeddings, or a few centroids?
- **What triggers re-clustering**, and how expensive is it as the number of
  speakers grows? pgvector over speaker rows should be fine for a long
  time.
- **Goldens in the database**: read-only, or exportable?
- **Migration.** Existing segments' `person_id` links all become `proposed`
  attributions from `recognition`, except seeded golden people (`seed`,
  confirmed). Existing anonymous people with one speaker could be dissolved
  back to local speakers. Stored embeddings don't exist for already-ingested
  meetings, so backfilling them needs the audio (work directories) or a
  re-run of embedding.
