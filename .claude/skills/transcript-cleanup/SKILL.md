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

## Rules

1. **Relabel only on evidence in the transcript:** a self-introduction ("this
   is uh Brian Burnett", "my name is Nick Cruz"), the chair calling on someone
   just before they speak, or a roll call. Topic or tone is not evidence.
   Without evidence, leave the label alone and report it.
2. **Speech recognition misspells names** (Bryan → Brian, Crews → Cruz,
   Giessel → Giesel). Match names loosely. When you name someone, follow the
   `people-records` skill.
3. **Turns blur at their edges.** In "Thank you. Brianna | Thank you, Kyle. I
   just…", the chair's handoff words belong to the chair. Split at the exact
   word where the speaker changes, then relabel each part.
4. **Choose the right kind of label.** A known person has a slug. An anonymous
   person is a voice that recognition saw again. A speaker number is a voice
   within one meeting only. Unattributed means unknown. Use `update_person` to
   name a recurring anonymous person. Use `merge_people` only when two person
   rows are certainly the same voice. Leave a one-off speaker on a speaker
   number.
5. **Don't untangle what needs the audio.** If one label seems to cover two
   voices and the text doesn't show which is which, fix only the segments with
   evidence and report the rest.
6. **Keep chapter text in step with labels.** After relabelling, check that
   chapter titles and summaries name the right people. Chapters follow
   `docs/chapters.md`. Write them with `replace_chapters`, with
   `reviewedByHuman: false` unless a human checked them.
7. **Voiceprints aren't recomputed.** Relabelling segments doesn't change
   anyone's voiceprint, so say so if recognition will depend on your fix.

## Report

For each change, give the segment or person, the old label, the new label,
and the evidence (quote the words). Then list what you left unresolved, and
why.
