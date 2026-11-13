# @open-minutes/changeset-review

Reviews [changesets](../edit/README.md#changesets) in GitHub issues before
they reach production. It holds the root `pnpm changeset` script.

## The flow

An issue labelled `changeset` proposes a changeset. Its comments hold each
version of the changeset, CI's check of each version, reviews, and the result
of applying it.

1. **Write and check it locally.** Write the changeset against a copy of
   production and run `pnpm changeset check` and `pnpm changeset view` on it
   until it changes what you meant.
2. **Propose it.** `pnpm changeset propose changeset.sql --title "..." --body
   "..."` opens the issue, labelled `changeset`, with the description you
   give, and posts the SQL as v1.
3. **CI checks it.** For each new or edited version,
   [`changeset-check.yml`](../../.github/workflows/changeset-check.yml) runs
   it against production and rolls it back. It comments whether it would
   apply, what it would change, and the rule violations it would resolve and
   introduce, with a link to the review page (one HTML file, kept as a
   workflow artifact for 90 days). CI only checks versions by people with
   write access.
4. **Review it.** A reviewer opens the review page, gives each statement a
   verdict (accept, reject or question) and a note, and pastes the page's
   "Copy review comment" into the issue. An agent posts a review with
   `pnpm changeset review <issue> review.json`, which writes the same comment.
5. **Revise it.** `pnpm changeset status <issue>` shows the versions, their
   checks and their reviews, and `pnpm changeset status <issue> --sql` prints
   the latest version's SQL. `pnpm changeset revise <issue> v2.sql --note
   "..."` posts the next version, which CI checks in turn. Review and revise
   until it's right.
6. **Approve it.** An admin or maintainer of the repository adds the label
   `changeset:approved`.
7. **CI applies it.**
   [`changeset-apply.yml`](../../.github/workflows/changeset-apply.yml)
   applies the latest version to production, comments with what it saved,
   swaps the label for `changeset:applied`, and closes the issue. If it can't,
   it comments why, removes `changeset:approved` and saves nothing.

An approval covers the latest version as it stood when the label was added,
and only if CI checked that version, as it stands, and found it would apply.
CI refuses an approval:

- by anyone but an admin or maintainer (anyone with triage access can add
  labels);
- when a version was posted, or the latest edited, after the label was
  added;
- when CI hasn't checked the latest version, or found it fails;
- of a version already applied.

To approve again after a refusal, add the label again.

Create the three labels in the repository: `changeset`, `changeset:approved`
and `changeset:applied`.

## The issue's comments

Each comment of the flow starts with a marker, an HTML comment GitHub doesn't
show, which `src/issue.ts` reads. A version is cited by its number and the
SHA-256 of its SQL, so an edit to a version is seen as a different version.

| Comment | Marker                                        | Posted by                                      | Holds                                                                                         |
| ------- | --------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Version | `<!-- changeset:version 2 -->`                | `propose`, `revise`; someone with write access | the SQL in a ` ```sql ` block, and a note: what changed since the last version, and why       |
| Check   | `<!-- changeset:check v2 sha256=<hex> ok -->` | CI (`ok` or `fails`)                           | the result, rows and rule violations, each statement's changes, and a link to the review page |
| Review  | `<!-- changeset:review v2 sha256=<hex> -->`   | anyone                                         | the review in Markdown, and as JSON in a ` ```json ` block                                    |
| Applied | `<!-- changeset:applied v2 sha256=<hex> -->`  | CI                                             | the rows and meetings it changed, and who approved it                                         |

Versions come only from people with write access, and checks and applied
results only from `github-actions[bot]`. A review by someone without write
access is shown as such.

A review's JSON, which `pnpm changeset review` takes as its input too:

```json
{
  "overall": "One fix, then fine.",
  "statements": [
    {
      "statement": 1,
      "verdict": "reject",
      "note": "Say \"7 p.m.\": the agenda does."
    },
    { "statement": 2, "verdict": "accept" }
  ]
}
```

`statement` numbers the version's statements from 1, as the review page
does. `verdict` is `accept`, `reject`, `question` or null (a note alone). The
comment also gives each statement's `line` and `kind`.

## Commands

A source is a SQL file, `-` for stdin, or an issue (`123`, `owner/name#123`
or its URL), whose latest version, or `--version N`, it takes. The issue
commands use `$GITHUB_TOKEN` or `$GH_TOKEN`, else `gh auth token`, and the
repository of this checkout's `origin`.

```sh
pnpm changeset check <source> [--db D]
pnpm changeset view <source> [--db D] [--out page.html] [--json diff.json] [--serve] [--no-open]
pnpm changeset apply <source> [--db D]
pnpm changeset propose <file> --title T [--body B | --body-file F]
pnpm changeset revise <issue> <file> [--note N | --note-file F]
pnpm changeset review <issue> <review.json> [--version N]
pnpm changeset status <issue> [--json] [--sql [--version N]]
pnpm changeset ci check <issue> --db D --out-dir DIR [--run-url U]
pnpm changeset ci apply <issue> --db D
```

`check` and `apply` are described in
[@open-minutes/edit](../edit/README.md#changesets). Apply to production
through an issue, not with `apply`. `ci check` and `ci apply` are what the
workflows run.

## The review page

`view` runs the changeset the way `check` does, in one transaction as the
`changeset` role that is rolled back, but a statement at a time. It writes
the page to the temp directory (`--out` to choose) and opens it; `--json`
also writes the diff as JSON. With `--serve` it serves the page on
`http://127.0.0.1:4400/` instead and reruns the changeset from its source on
every reload, so you can edit the SQL and reload. `--context` sets how many
words of transcript to show around each change (default 8).

- **Header**: the issue and version, if it came from one, the database it
  ran against and when, the SQL's SHA-256, the meetings it changes, and
  whether it would apply. If it applies, the rows it would change and, in
  each meeting, the rule violations it would resolve and introduce, as
  `check` reports them. If it fails, the statement it fails at and why; the
  statements after it didn't run.
- **A card per statement**, in order:
  - the comment written above it in the SQL, and the SQL itself;
  - the om function it calls (or its first keyword, such as `UPDATE`), the
    first onset among its arguments, its line, and the rows it changed;
  - for each meeting it changed, under the meeting's name when there's more
    than one:
    - each change in a line: words replaced (`"good wood" -> "Girdwood" at
      0:10:44.08`), a new speaker from a word on, or a segment of the same
      speaker starting or ending;
    - hunks: the segments around each change, before and after, side by
      side, with each segment's speaker (name and label), onset and index,
      deleted words struck out in red and inserted words in green, and a
      segment that starts differently on one side marked;
    - the meeting's slug and title, if it changed them;
    - the rule violations it resolved and introduced, comparing the meeting
      just before and just after it. A violation one statement introduces, a
      later one may resolve;
  - the slug, name and bio of each person it changed;
  - for an `om.assert`, that it held.
- **A review form**: per statement, accept, reject or question, and a note;
  and a note on the whole changeset. "Copy review comment" copies the review
  comment. The review is kept in the browser's localStorage, by issue and by
  each statement's SQL, so the verdicts of statements a new version leaves
  unchanged carry over.

## How it works

`buildChangesetDiff` (in `./build`) runs a changeset and returns a
`ChangesetDiff` (`src/types.ts`), plain JSON:

1. `splitStatements` splits the SQL at the semicolons outside strings,
   quoted identifiers, dollar quotes and comments, keeping each statement's
   comment and line.
2. `checkChangeset` in `@open-minutes/edit`, given those statements as a
   `trace`, runs them one at a time, in the transaction and role `check`
   uses, and calls back after each with the rows it changed and each meeting
   and person it changed, before and after it. The first time a statement
   changes a meeting or person, it rolls the statement back to a savepoint,
   loads them, and runs it again. It still makes every check `check` makes,
   and rolls back.
3. `diffTranscripts` diffs each meeting's transcripts word by word (Myers'
   diff on each word's text and onset to the hundredth), notes where a
   segment starts on one side only or with another speaker, and groups the
   changes into hunks with context.
4. The meeting rules run on each meeting in between, to say which violations
   each statement resolved and introduced.

`renderPage` (in `.`) turns a diff into HTML, with no database or Node.
`src/client.js` is the review form's script, a plain script inlined into the
page; `pnpm changeset review` formats its comment with the same script.
`src/comments.ts` writes CI's comments, `src/issue.ts` reads the issue's, and
`src/github.ts` calls GitHub's REST API.

## TODO

- Show the whole changeset's diff, each meeting before the first statement
  against after the last, as well as each statement's.
- Comment on a single word or segment of a hunk, not only on a statement.
- Link each onset to that moment in the meeting's recording on the website.
- Serve the review page from the website rather than as an artifact, which
  only people logged in to GitHub can download.
