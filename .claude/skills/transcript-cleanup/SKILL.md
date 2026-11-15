---
name: transcript-cleanup
description: Fix who-said-what, misheard words and people in an Open Minutes meeting's transcript, in the database. Use when correcting speaker labels, splitting or merging segments, fixing misheard words or numbers, or naming the people who speak.
---

# Transcript cleanup

## Tools

`pnpm transcript` reads a meeting in the database and applies the rules'
fixes to it, and `pnpm changeset` checks changesets against it, shows what
they do, and proposes them for production. `--db` names the database: `prod`
for production.

```sh
pnpm transcript render <meeting> --from H:MM:SS --to H:MM:SS --db prod
pnpm transcript words <meeting> <from> <to> --db prod
pnpm transcript stats <meeting> --db prod
pnpm transcript check <meeting> --db prod
pnpm transcript fix <meeting> --dry-run --db prod
pnpm transcript fix <meeting> --db prod
pnpm changeset check changeset.sql --db prod
pnpm changeset view changeset.sql --db prod --no-open
pnpm changeset propose changeset.sql --title "..." --body "..."
pnpm changeset status <issue>
pnpm changeset revise <issue> changeset.sql --note "..."
```

`<meeting>` is a slug or an id. `render` shows the transcript a segment at a
time with the onset of every sentence, `words` lists each word's onset, and
`stats` lists who speaks how much, with each person's id and name.

`pnpm transcript check` lists everything the rules in
`packages/core/src/rules/` find in a meeting. Read every warning and decide
whether the data is right as it is. Transcripts carry no fillers ("um",
"uh") or stutters ("the the"): `pnpm transcript fix` removes them, along
with whatever else the rules can fix on their own, and doesn't save a fix
that adds an error.

A speaker label is `identified:<slug>` for a known person, `person:<id>` for
a person with no slug yet, `segmented:spk-<n>` or `unlabeled`. A label can
only name someone with a row in the database. Name people following the
`people-records` skill.

## Changesets

Make every other change in a changeset: one SQL file. Don't apply one to
production yourself; propose it.
`pnpm changeset check` runs it and rolls it back, reporting the rows it would
change and, in each meeting it changes, the rule violations it would resolve
and introduce. `pnpm changeset view` does the same a statement at a time and
writes a page showing what each statement does. `pnpm changeset --help` and
`packages/edit/README.md` describe the functions in full.

- `SELECT om.split_segment(M, T, W, L);` makes the word `W` at onset `T`
  start a new segment spoken by `L`, running to the end of its segment. Split
  again where the previous speaker resumes to give the turn back. Splitting
  in descending time order keeps a split from relabelling the segment an
  earlier one made.
- `SELECT om.relabel(M, T, L);` relabels the whole segment holding the word
  at `T`.
- `SELECT om.replace_words(M, T, 'good wood', 'Girdwood');` fixes misheard
  words starting at `T`, which must read the old words exactly.
- `SELECT om.insert_words(M, ARRAY['0:01:57.24 Are', '0:01:57.52 we'], L);`
  adds missed words, as their own turn with `L`, or into the segment they
  follow without it.
- `SELECT om.replace_all_words(M, 'Gridwood', 'Girdwood');` fixes every
  occurrence and returns the count. A common word ("Kelly") may match more
  than one person.
- Plain SQL sets people's slugs, names and bios, and the meeting's slug and
  title: `UPDATE people SET slug = 'kyle-kelley', name = 'Kyle Kelley', bio
  = '...' WHERE id = 57;`. Do it before the labels that use the slug.
- To merge two people who turn out to be the same person, move one's
  segments to the other, in every meeting, then delete them: `UPDATE
  segments SET person_id = 12 WHERE person_id = 57; DELETE FROM people WHERE
  id = 57;`.
- `SELECT om.assert(condition, 'message');` stops the changeset unless the
  condition holds. Assert what each change assumes: that a person still has
  no slug, how many segments a voice has, how many words `replace_all_words`
  replaced.

Each edit takes the meeting `M` by slug or id, onsets as `render` and
`words` print them, and speaker labels `L`, and merges neighbouring segments
left with the same speaker. Put a `--` comment above each change with its
evidence: reviewers read it next to the statement. Check the changeset until
it changes the rows you expect and introduces no violations you didn't
intend.

Then propose it: `pnpm changeset propose` opens an issue labelled
`changeset` with your description and the SQL as v1. CI checks each version
against production and comments with the result and a link to its review
page on the website. If CI says production changed what a version does, read which
statements and why before answering. To answer a review, read it with `pnpm changeset status <issue>` (`--json` for the
reviews' verdicts and notes by statement number, `--sql` for the latest
version's SQL; skip reviews marked stale), fix the changeset, and post it with `pnpm changeset revise`,
saying in `--note` what changed and which review it answers. A maintainer
approves the issue, and CI applies the latest version.
`packages/changeset-review/README.md` describes the flow.

To review a changeset someone else proposed, read its statements with
`pnpm changeset view <issue> --db prod --json diff.json --no-open`, and post
your verdicts with `pnpm changeset review <issue> review.json`.

## Rules

1. **Relabel only on evidence.** Evidence is:
   - a self-introduction ("this is uh Brian Burnett", "my name is Nick Cruz"),
     or a name spelled for the record (trust the letters over the recognized
     word);
   - the chair calling on someone just before they speak ("Yes, Margaret.",
     "Chief Weston."), or a reply to a question asked of them by name;
   - a later reference to whoever just spoke ("As Ryan mentioned", "I agree
     with Nick");
   - the chair restating a motion ("Moved by Ms. Brawley, second by Mr.
     Volland"), which names the bare "So moved." and "Second." before it;
   - a roll call, including an unnamed answer placed by the body's fixed roll
     order or by elimination against the announced tally ("passes 4-1");
   - official minutes, which name movers, seconders, reporters and public
     commenters.

   Topic or tone is not evidence. Without evidence, leave the label alone and
   report it.

2. **Speech recognition misspells names** (Brian → Bryan, Crews → Cruz,
   Giessel → Giesel). Match names loosely. When you name someone, follow the
   `people-records` skill. Officials' surnames often come out as unrelated
   phrases ("can't call this" for Kohlhase, "Great C" for Greg Soule), so
   read each speaker's first sentence against the roster.
3. **Turns blur at their edges.** In "Thank you. Brianna | Thank you, Kyle. I
   just…", the chair's handoff words belong to the chair. Split at the exact
   word where the speaker changes, then relabel each part. Edges are usually
   off by one to five words, most often with the next segment starting on the
   previous speaker's last words ("Thank | you."), so check the first and last
   words of every segment. The rules warn about a
   speaker change inside a sentence near a longer pause; the pause hints
   which way to move it, but read the words to decide who said them.
4. **Give every voice change its own segment.** The diarizer often folds
   short turns into the chair's segment: roll-call answers, "So moved." and
   "Second.", one-line questions inside a presentation, and the clerk reading
   a vote tally. In some meetings it folds most in-room speakers into the
   chair while online speakers get clean clusters. A long chair segment that
   holds a presentation usually starts after a first-name handoff ("item nine
   … Jennifer."), or after the chair reads an agenda item that names its
   sponsor ("GTC request … (Burnett)"). Long runs with no punctuation usually
   hide a turn change. The rules warn about a bare
   "Yes." or "Second." left in the segment of whoever asked for it.
5. **Check every segment of a cluster before labelling the whole cluster.**
   One `segmented:spk-N` can hold unrelated voices: a legislator and a police
   chief, or a member, a staffer and a presenter. Music before a meeting or
   during a break can also get its own cluster; leave it alone.
6. **Choose the right kind of label.** A known person is
   `identified:<slug>`, their stable ID across meetings. A person nobody has
   given a slug yet is `person:<id>`; once you have evidence of who they
   are, give them a slug, name and bio. A speaker number
   (`segmented:spk-<n>`) is a voice within one meeting only. `unlabeled`
   means unknown. Leave a one-off speaker on a speaker number. A
   split-out voice with no name gets a speaker number not yet used in that
   meeting.
7. **Don't untangle what needs the audio.** If one label seems to cover two
   voices and the text doesn't show which is which, fix only the segments with
   evidence and report the rest.
8. **Fix misheard words when the intended word is clear:** place names,
   bodies and acronyms, people's names (spelled as their person's name is), and
   plain mishearings ("low cloud" → "roll call"). Keep the fix local ("good
   wood" → "Girdwood" is one word), don't rewrite grammar, and leave a number
   or a name alone when you aren't sure. `packages/glossary/src/glossaries.ts`
   lists the local words of each region and how speech recognition mishears
   them.
9. **Write numbers the house way.** Transcripts write numbers, times, money
   and dates as `packages/core/src/rules/numbers.ts` describes:
   "7:30 p.m.", "$36,000", "3.79%", "March 19", "passes 5-0", and numerals
   from 10 up. Some bodies follow rules of their own for their identifiers,
   which `pnpm transcript check` applies; Anchorage's bodies write "AO
   2026-23", "AO 2025-144(S)", "AM 142-2026", "AMC 21.05.040G.2", "item
   10.B.1" and "R-4". Collapse a spoken number into one word with one
   `om.replace_words` per number ("twenty twenty six dash twenty" →
   "2026-20"), and write only what was said: a number you can't make out
   stays as heard.
   The rules report the rest.
10. **Keep chapter text in step with labels.** After relabelling, check that
    the meeting's chapter titles and summaries name the right people, and
    report any that don't. Chapters follow `docs/chapters.md`.

## Report

Give the issue's URL and what CI's check of the latest version reported. For each change,
give the segment or person, the old label, the new label, and the evidence
(quote the words). Then list what you left unresolved, and why.
