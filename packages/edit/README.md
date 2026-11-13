# @open-minutes/edit

Reads a meeting in a database, applies the meeting rules' fixes to it, runs
changesets on it, and moves golden meetings between a database and the
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

## Changesets

A changeset is a SQL file of changes and assertions for one meeting: who said
what, misheard words, people's slugs, names and bios, and the meeting's slug
and title.

```sh
pnpm transcript apply gbos-2026-03-23 changeset.sql --dry-run --db prod
pnpm transcript apply gbos-2026-03-23 changeset.sql --db prod
```

```sql
SELECT om.assert(
  (SELECT slug FROM people WHERE id = 57) IS NULL,
  'person 57 has no slug yet'
);
UPDATE people SET slug = 'kyle-kelley', name = 'Kyle Kelley',
  bio = 'Girdwood Board of Supervisors member as of March 2026.'
WHERE id = 57;
SELECT om.split_segment('gbos-2026-03-23', '0:10:41.52', 'Thank', 'identified:kyle-kelley');
SELECT om.replace_words('gbos-2026-03-23', '0:10:44.08', 'good wood', 'Girdwood');
SELECT om.assert(
  om.replace_all_words('gbos-2026-03-23', 'Gridwood', 'Girdwood') = 3,
  'three Gridwoods'
);
```

`apply` runs the file in one transaction that holds the meeting's row lock, and
reports how many rows it changed in each table; `--dry-run` saves nothing. It
saves nothing if a statement fails, or if the changeset changes another
meeting's segments, chapters or row. It doesn't run the meeting rules, since a
meeting partway through a cleanup breaks them in passing; `check` runs them
when you want to know.

The SQL runs as the `changeset` role, inside `om.run`, so it can't change its
role, and its `BEGIN`, `COMMIT` and `ROLLBACK` fail. The role reads every
table, inserts, updates and deletes segments, updates people's `slug`, `name`
and `bio` and meetings' `slug` and `title`, and calls the `om` functions. It
can't create or alter tables or other objects, and `apply` saves nothing that
creates a temporary one. Whoever runs the migrations is a member of the role;
`apply` needs to connect as a member.

The `om` functions edit a meeting's segments. Each takes the meeting by slug
or id, a word by its onset as `render` and `words` print it (`H:MM:SS.ss`,
matched to the hundredth), and a speaker by its label. After each one, no two
neighbouring segments have the same speaker, and no segment is empty. A label
sets a segment's speaker to exactly that: a person and no speaker number, or
the reverse.

| Function                                       | What it does                                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `om.split_segment(meeting, at, word, speaker)` | The word at `at` (equal to `word`, unless null) starts a new segment spoken by `speaker`, running to the end of its segment. If it already starts one, that whole segment is relabelled.                                |
| `om.relabel(meeting, at, speaker)`             | Relabels the whole segment holding the word at `at`.                                                                                                                                                                    |
| `om.replace_words(meeting, at, old, new)`      | Replaces the words starting at `at`, which must read `old`, with `new`, which may have more or fewer words; `''` deletes. A new word takes the onset of the old word in its place, or of the last old word.             |
| `om.insert_words(meeting, words, speaker)`     | Adds words the transcript is missing, an array of `'H:MM:SS.ss word'`. With `speaker`, they are their own segment and the words after them go back to whoever was speaking; without, they join the segment they follow. |
| `om.replace_all_words(meeting, old, new)`      | Replaces every occurrence of `old`, ignoring case and trailing punctuation and keeping the last old word's, and returns the count.                                                                                      |
| `om.assert(condition, message)`                | Raises `message`, with SQLSTATE `OM001`, unless `condition` is true. `apply` reports it as a failed assertion.                                                                                                          |

An onset that matches no word raises an error that lists the words near it.
Plain SQL works too: an `UPDATE` of `segments.words` or `person_id`, say. The
`segments` row's `text`, `start_secs` and the rest follow its `words`.

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
