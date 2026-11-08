# @open-minutes/edit

Reads a meeting in a database and applies the meeting rules' fixes to it, and
moves golden meetings between a database and the
[datums](../datasets/README.md).

A meeting lives in a database. The golden meetings in
`packages/datasets/datums/` are exported from production: to correct one, edit
it in production and export it again. Don't edit the golden files by hand.

## Reading and fixing a meeting

`pnpm transcript <command> <meeting>` takes a meeting by slug or id, and
`--db` to choose the database (default `$DB`, else your branch's local one;
see [docs/contributing/db.md](../../docs/contributing/db.md)).

```sh
pnpm transcript render gbos-2026-03-23 --from 0:10:00 --to 0:12:00 --db prod
pnpm transcript words gbos-2026-03-23 0:10:41 0:10:45 --db prod
pnpm transcript stats gbos-2026-03-23 --db prod
pnpm transcript check gbos-2026-03-23 --db prod
pnpm transcript fix gbos-2026-03-23 --db prod
```

- `render` shows the transcript a segment at a time, with the onset of every
  sentence. `words` lists each word's onset, to find a split point inside a
  sentence. `stats` lists segments and words per speaker.
- `check` reports what the [meeting rules](../core/README.md#rules) find.
- `fix` applies the rules' fixes: it drops fillers and stutters, writes
  numbers the house way, and so on.
  `fix` runs in one transaction holding the meeting's row lock, then checks
  the result against the rules. A fix that adds a rule error isn't saved unless
  you pass `--allow-errors`; `--dry-run` saves nothing.

Speakers are shown as labels: `unlabeled`, `segmented:spk-<n>`,
`identified:<slug>`, or `person:<id>` for a person with no slug yet.

## Golden meetings

```sh
pnpm goldens export gbos-2026-03-23 --db prod
pnpm goldens publish gbos-2026-03-23 --db prod
```

`export` writes meetings as golden meetings: each one's directory under
`datums/meetings/` (`meeting.json`, `golden.psv`, `chapters.json`), and a line
in `people.jsonl` for everyone it names. A golden needs a slug and a
duration, and everyone it names needs a slug and a name;
`export` lists what's missing. It keeps the audio hash from the existing
`meeting.json`, and for a new golden downloads the audio to compute it.

`publish` goes the other way, for a golden whose files are ahead of the
database. It changes only that meeting and the people it names: the meeting
row (found by slug, else by its recording, which it adds if the database
doesn't have it), its bodies, segments and chapters,
and the name and bio of each person. It finds a person by slug, or else as
the one person with the same name and no slug, and gives them the slug.
Anyone else is added, with a voiceprint from the meeting's audio. It reports
the changes, and saves them only with `--yes`.

Seeding the `all` dataset and exporting every golden reproduces the files
exactly, and so does publishing them into a database and exporting them; the
tests check both.
