---
name: transcript-cleanup
description: Fix who-said-what, people, and chapters in Open Minutes meeting data. Use when correcting speaker labels, splitting or merging segments, naming people, or writing chapters, in the database or in golden fixture files.
---

# Transcript cleanup

## Tools

Edit the database only through `@open-minutes/tools`, never raw SQL:

- Shell: `pnpm tools` lists the tools, `pnpm tools <tool> --schema` shows a
  tool's input, and `pnpm tools <tool> '<json>'` calls it. Output is JSON.
- TypeScript: `import { tools, toAgentTool } from "@open-minutes/tools"`.

Every write returns `issues` for the meetings it touched, and it rolls back
if the change introduces an error. Read the issues each time. Pass
`"dryRun": true` to preview a change.

Golden fixtures (`packages/fixtures/test-data/`) are files. Check them with
`pnpm fixtures:check`. In a PSV file, a speaker marker goes on the line just
before its first word, with the same onset. Transcripts carry no fillers
("um", "uh") or stutters ("the the"): `pnpm fixtures:clean` removes them, so
never type one back in.

Edit a golden with [scripts/psvtool.py](scripts/psvtool.py) rather than by
hand: `render` shows it a segment at a time with the onset of every sentence,
`words` lists each word's onset, and `apply` takes a file of `split`, `label`,
`replace` and `replace_all` ops (run it with no arguments for details). Keep
the ops files, or the script that generates them, so a batch can be fixed and
re-run. `fixtures:check` doesn't verify that an `identified:` slug exists in
`people.jsonl`, so add every new person yourself.

Running `transcribe.test.ts` with `SNAPSHOT_UPDATE=1` rewrites a golden's
words from fresh recognition and keeps only its speaker layer, which discards
every hand-corrected word.

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
     commenters (see [mishearings.md](mishearings.md) for where to find them).

   Topic or tone is not evidence. Without evidence, leave the label alone and
   report it.
2. **Speech recognition misspells names** (Bryan → Brian, Crews → Cruz,
   Giessel → Giesel). Match names loosely. When you name someone, follow the
   `people-records` skill. Officials' surnames often come out as unrelated
   phrases ("can't call this" for Kohlhase, "Great C" for Greg Soule), so
   read each speaker's first sentence against the roster.
3. **Turns blur at their edges.** In "Thank you. Brianna | Thank you, Kyle. I
   just…", the chair's handoff words belong to the chair. Split at the exact
   word where the speaker changes, then relabel each part. Edges are usually
   off by one to five words, most often with the next segment starting on the
   previous speaker's last words ("Thank | you."), so check the first and last
   words of every segment.
4. **Give every voice change its own segment.** The diarizer often folds
   short turns into the chair's segment: roll-call answers, "So moved." and
   "Second.", one-line questions inside a presentation, and the clerk reading
   a vote tally. In some meetings it folds most in-room speakers into the
   chair while online speakers get clean clusters. A long chair segment that
   holds a presentation usually starts after a first-name handoff ("item nine
   … Jennifer."). Long runs with no punctuation usually hide a turn change.
5. **Check every segment of a cluster before labelling the whole cluster.**
   One `segmented:spk-N` can hold unrelated voices: a legislator and a police
   chief, or a member, a staffer and a presenter. Music before a meeting or
   during a break can also get its own cluster; leave it alone.
6. **Choose the right kind of label.** A known person has a slug, their
   stable ID across meetings, databases and fixtures. An anonymous
   person is a voice that recognition saw again. A speaker number is a voice
   within one meeting only. Unattributed means unknown. Use `update_person` to
   name a recurring anonymous person. Use `merge_people` only when two person
   rows are certainly the same voice. Leave a one-off speaker on a speaker
   number. In a golden, a split-out voice with no name gets a speaker number
   not yet used in that meeting.
7. **Don't untangle what needs the audio.** If one label seems to cover two
   voices and the text doesn't show which is which, fix only the segments with
   evidence and report the rest.
8. **Fix misheard words when the intended word is clear:** place names,
   bodies and acronyms, people's names (in the `people.jsonl` spelling), and
   plain mishearings ("low cloud" → "roll call"). Keep the fix local ("good
   wood" → "Girdwood" is one word), don't rewrite grammar, and leave a number
   or a name alone when you aren't sure. [mishearings.md](mishearings.md)
   lists the recurring ones.
9. **Keep chapter text in step with labels.** After relabelling, check that
   chapter titles and summaries name the right people. Chapters follow
   `docs/chapters.md`. Write them with `replace_chapters`, with
   `reviewedByHuman: false` unless a human checked them.
10. **Voiceprints aren't recomputed.** Relabelling segments doesn't change
   anyone's voiceprint, so say so if recognition will depend on your fix.

## Report

For each change, give the segment or person, the old label, the new label,
and the evidence (quote the words). Then list what you left unresolved, and
why.
