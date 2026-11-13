# @open-minutes/changeset-view

Shows what a [changeset](../edit/README.md#changesets) does to a meeting,
statement by statement, as a page a reviewer reads and comments on instead of
applying the SQL in their head. It also holds the root `pnpm changeset`
script, whose `check` and `apply` commands come from `@open-minutes/edit`.

```sh
pnpm changeset view changeset.sql --meeting gbos-2026-03-23 --db local
pnpm changeset view https://github.com/NickCrews/open-minutes/issues/215 --db local
pnpm changeset view changeset.sql --meeting 5 --serve
```

`view` runs the changeset the way `check` does, in one transaction as the
`changeset` role that is rolled back, so it saves nothing. It writes the page
to `changeset-<meeting>.html` in the temp directory (`--out` to choose) and
opens it; `--json` also writes the diff as JSON. With `--serve` it serves the
page on `http://127.0.0.1:4400/` instead and reruns the changeset from its
source on every reload, so you can edit the SQL and reload. `--context` sets
how many words of transcript to show around each change (default 8).

## What the page shows

- **Header**: the meeting, the database it ran against and when, where the
  changeset came from, and whether it would apply. If it applies, the rows it
  would change by table and the meeting rule violations it would resolve and
  introduce, as `check` reports them. If it fails, the statement it fails at
  and why; the statements after it didn't run.
- **A card per statement**, in order:
  - the comment written above it in the SQL, and the SQL itself;
  - the om function it calls (or its first keyword, such as `UPDATE`), the
    first onset among its arguments, and its line in the changeset;
  - the rows it changed, by table;
  - each change in a line: words replaced (`"good wood" -> "Girdwood" at
    0:10:44.08`), a new speaker from a word on, or a segment of the same
    speaker starting or ending;
  - hunks: the segments around each change, before and after, side by side,
    with each segment's speaker (name and label), onset and index, deleted
    words struck out in red and inserted words in green, and a segment that
    starts differently on one side (split, merged or relabelled) marked;
  - fields of the meeting (slug, title) and of the meeting's people (slug,
    name, bio) it changed;
  - the rule violations it resolved and introduced, comparing the meeting
    just before and just after it. These can differ from the whole
    changeset's: a violation one statement introduces, a later one may
    resolve;
  - for an `om.assert`, that it held.
- **A review form**: per statement, accept, reject or question, and a note;
  and a note on the whole changeset. "Copy review as Markdown" copies the
  review, ready to paste as a comment on the changeset's issue: a line of
  totals, the overall note, each rejected, questioned or annotated statement
  with its change and note, then the accepted ones. The review is kept in
  the browser's localStorage, by meeting and by each statement's SQL, so
  rerunning the changeset, or editing it, keeps the verdicts of the
  statements that didn't change.

## How it works

`buildChangesetDiff` (in `./build`) is the library entry point: given a
database, a meeting and the changeset's SQL, it returns a `ChangesetDiff`
(`src/types.ts`), plain JSON.

1. `splitStatements` splits the SQL at the semicolons outside strings,
   quoted identifiers, dollar quotes and comments, keeping each statement's
   comment and line.
2. `checkChangeset` in `@open-minutes/edit`, given those statements as a
   `trace`, runs them one at a time, in the transaction and role `check`
   uses, and calls back after each with the meeting before and after it and
   the rows it changed (from the `om.changes` log). It still makes every
   check `check` makes, and rolls back.
3. `diffTranscripts` diffs the two transcripts word by word (Myers' diff on
   each word's text and onset to the hundredth), notes where a segment starts
   on one side only or with another speaker, and groups the changes into
   hunks with context.
4. The meeting rules run on each meeting in between, to say which violations
   each statement resolved and introduced.

`renderPage` and `renderReport` (in `.`) turn a diff into HTML. They need no
database or Node, so the website renders diffs with them in the browser.
`src/client.js` is the review form's script, a plain script so it can be
inlined into the page or added to it.

### Where a changeset comes from

`view` takes a SQL file, `-` for stdin, or a URL. A GitHub issue, pull
request or issue comment URL is read through GitHub's API (with
`$GITHUB_TOKEN` or `$GH_TOKEN` if set, for private repositories); any other
URL is fetched as is. Markdown, as in an issue, gives its first ` ```sql `
block, and its first `--meeting <slug-or-id>` names the meeting, unless
`--meeting` is given.

### The base

The "before" is the meeting as it is in the database `--db` names, the
**base**: `local` by default, another name from `.env.local`, or a
`postgres://` URL. To review a changeset against the database its author
wrote it against, point `--db` at that database, such as a local copy of a
production export or a Neon branch. The page records the base by name, or a
URL's host and database, never its password.

### On the website

`/changesets` on the website, linked from nowhere and not indexed, shows a
diff from `?url=<diff.json>`, or one dropped on the page or chosen as a file:
the JSON `view --json` writes, or `/diff.json` from `view --serve`. It renders
in the browser and reads no database, so the site never runs a changeset.

## TODO

- Change the base from the page: pick another database, or a dump, and
  rerun, in `--serve` mode.
- Post the review to the changeset's issue with `gh issue comment` from
  `--serve` mode, instead of copying the Markdown.
- Show the whole changeset's diff, the meeting before the first statement
  against after the last, as well as each statement's.
- Comment on a single word or segment of a hunk, not only on a statement.
- Link each onset to that moment in the meeting's recording on the website.
- Read a changeset revised in a later issue comment by default; today, pass
  that comment's URL.
