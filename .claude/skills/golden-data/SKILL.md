---
name: golden-data
description: Change Open Minutes' golden meetings, the hand-verified fixtures in packages/datasets/datums/ that tests and benchmarks use. Use when correcting a golden meeting, adding one, or changing people.jsonl, chapters.json or a golden.psv.
---

# Golden data

The golden meetings are meetings from production, cleaned up by hand and
exported as files for the tests and benchmarks: each is a directory under
`packages/datasets/datums/meetings/<slug>/` (`meeting.json`, `golden.psv`,
`chapters.json`), and everyone they name has a line in
`packages/datasets/datums/people.jsonl`.

These files are generated. Never edit them by hand: change the meeting in
production, then export it again. `jurisdictions.jsonl` and `bodies.jsonl`
are the exception, and are edited by hand.

## Correcting a golden meeting

1. Clean up the meeting in production following the `transcript-cleanup`
   skill, with `--db prod`. Name people following the `people-records`
   skill.
2. Export it:

   ```sh
   pnpm goldens export <slug> --db prod
   ```

3. Run `pnpm datasets:check` on the meeting's files, and fix any error in
   production and export again.
4. Review the diff. A relabel is a moved `begin_speaker` line, and a fixed
   word a changed `text` line; anything larger than the edit you made
   means production had changes the files didn't, which should be checked.

Export refuses a meeting it can't write, and lists why:

- The meeting needs a slug, `<body>-<date>` (eg `gbos-2026-03-23`). Set it
  with a `{"op":"meeting","slug":"..."}` op.
- Everyone it names needs a slug and a name. A person with no slug yet
  (`person:<id>`) needs one from a `person` op, or their segments relabelled
  with a speaker number.

## Adding a golden meeting

Pick a meeting in production, give it a slug, clean it up, and export it. A
new golden's audio is downloaded once to record its hash in `meeting.json`.
Goldens must be clean: every rule error fails the fixture tests.

## When the files are ahead of production

If a golden's files hold corrections production doesn't have, publish them
before anyone exports it, or the export will undo them:

```sh
pnpm goldens publish <slug> --db prod
pnpm goldens publish <slug> --db prod --yes
```

The first reports what would change, including which production people it
matches to `people.jsonl` by name; check those, then save with `--yes`.

## Chapters

Export writes the meeting's chapters to `chapters.json`, following
`docs/chapters.md`, with `"reviewed_by_human": false` unless a human checked
them.
