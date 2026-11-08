---
name: transcript-cleanup
description: Fix who-said-what, misheard words and people in an Open Minutes meeting's transcript, in the database. Use when correcting speaker labels, splitting or merging segments, fixing misheard words or numbers, or naming the people who speak.
---

# Transcript cleanup

## Tools

Meetings are edited in the database with `pnpm transcript`. `--db` names the
database: `prod` for production.

```sh
pnpm transcript render <meeting> --from H:MM:SS --to H:MM:SS --db prod
pnpm transcript words <meeting> <from> <to> --db prod
pnpm transcript stats <meeting> --db prod
pnpm transcript check <meeting> --db prod
pnpm transcript apply <meeting> ops.jsonl --dry-run --db prod
pnpm transcript apply <meeting> ops.jsonl --db prod
pnpm transcript fix <meeting> --db prod
```

`<meeting>` is a slug or an id. `render` shows the transcript a segment at a
time with the onset of every sentence, `words` lists each word's onset, and
`stats` lists who speaks how much, with each person's id and name. `apply`
takes a file of `split`, `label`, `replace`, `insert` (for words the
transcript is missing), `replace_all`, `person` and `meeting` ops; `pnpm
transcript apply --help` describes them. Keep the ops files, or the script
that generates them, so a batch can be fixed and re-run. Try each batch with
`--dry-run` first.

`apply` and `fix` check the result against the rules in
`packages/core/src/rules/` and don't save an edit that adds an error. Read
every warning it reports and fix it unless the data is right as it is.
Transcripts carry no fillers ("um", "uh") or stutters ("the the"): `pnpm
transcript fix` removes them, so never type one back in. `pnpm transcript
check` lists everything the rules find in a meeting.

A speaker label is `identified:<slug>` for a known person, `person:<id>` for
a person with no slug yet, `segmented:spk-<n>` or `unlabeled`. A label can
only name someone with a row in the database. To make an anonymous person
known, give them a slug, name and bio with a `person` op, following the
`people-records` skill.

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
   are, give them a slug with a `person` op. A speaker number
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
   `replace` op per number ("twenty twenty six dash twenty" → "2026-20"),
   and write only what was said: a number you can't make out stays as heard.
   The rules report the rest.
10. **Keep chapter text in step with labels.** After relabelling, check that
    the meeting's chapter titles and summaries name the right people, and
    report any that don't. Chapters follow `docs/chapters.md`.

## Report

For each change, give the segment or person, the old label, the new label,
and the evidence (quote the words). Then list what you left unresolved, and
why.
