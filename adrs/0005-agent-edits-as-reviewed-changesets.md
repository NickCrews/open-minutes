# ADR 0005: Agents edit the database through reviewed SQL changesets

Date: 2026-10-18
Status: Proposed

## Context

Agents clean up meeting data: who said what, people, chapters, meeting
details. The tools in `@open-minutes/agents` commit each edit straight to the
database, one transaction per tool call (`applyEdit` in
`packages/agents/src/tools.ts`). There is no point between "the agent decided"
and "the data changed" where a human or another agent can review the work, no
record of a session's edits as one unit, and no way to test a set of edits
before it lands.

## Decision

An agent's work product is a **changeset**: one SQL file of data changes and
assertions, checked against the database without committing, and applied only
after review.

### Data model

- **Main** is the current database state.
- An agent works on one changeset. Its **before** is main as it is when the
  harness checks the changeset; its **after** is before plus the changeset.
- A changeset holds:
  - `migration.sql`: the Postgres statements to apply, in order, with its
    assertions among them.
  - `rationale.md`: optional notes for the reviewer.
  - The **row diff**: the rows `migration.sql` inserted, updated and deleted
    at its latest check, and when that check ran.
- Changesets are kept as the audit trail, whatever their outcome.

### Checking without a branch

The harness computes after in a transaction on main that it always rolls
back:

1. `BEGIN`
2. Run `migration.sql`.
3. Read the row diff, run `check_meeting`, and answer the agent's queries
   (on after).
4. `ROLLBACK`

`migration.sql` runs on its own connection as the `changeset` role, inside
`om.run(sql)`, a plpgsql function that `EXECUTE`s it, where `COMMIT` and
`ROLLBACK` raise instead of ending the transaction. An `AFTER` row trigger on
each data table writes the old and new row to a log table when `session_user`
is `changeset`, which the changeset's SQL can't change. The row diff is that
log, read before the rollback.

This needs nothing but Postgres, so it works on any provider, locally and in
tests. A check holds locks on the rows it touches until it rolls back;
changesets are scoped to one meeting and checks take seconds, so that is
acceptable on production. Only the harness holds a writing connection; the
agent's own access to the database is read-only.

### Agent UX

The agent is an ordinary coding agent (bash, read, write, edit). It writes
`migration.sql`, and optionally `rationale.md`. The harness takes those files
as the final product.

The agent works in a loop of editing the file and running the harness:

- `om changeset check`: runs a check and prints the first failed assertion if
  any, else a summary of the row diff and the change in `check_meeting`
  results (issues fixed and issues introduced).
- `om changeset query '<sql>'`: runs the query on after, inside a check.

After is always rebuilt from the file, so the file and the result can't
drift apart. The agent also keeps read-only access to main and the read-only
tools (transcript, people, audio).

A changeset covers one meeting or one task, so review stays manageable and
conflicts stay rare.

### Review

The reviewer, human or agent, reads the row diff, shown in domain terms (eg a
transcript with relabelled segments highlighted) rather than as SQL, alongside
the `check_meeting` change and the rationale. An approval binds to the hash of
`migration.sql` and the hash of the row diff.

### Applying

Applying is a check that commits:

1. `BEGIN`
2. Insert the changeset's row into a `changesets` table, keyed by its id. A
   second apply fails on the key, so double-apply is impossible.
3. Run `migration.sql`. A failed assertion rolls back and marks the
   changeset conflicted.
4. Compare the row diff to the approved one, as described under
   [Row identity](#row-identity). A mismatch rolls back and marks the
   changeset conflicted.
5. `COMMIT`

A conflicted changeset needs review again.

### Assertions

An assertion is a statement in `migration.sql` that raises an error when a
condition fails, which aborts the transaction. A function in the schema keeps
them short:

```sql
SELECT om.assert(
  NOT EXISTS (SELECT 1 FROM people WHERE id = 12 AND slug IS NOT NULL),
  'person 12 already has a slug'
);
UPDATE people SET slug = 'jane-doe', name = 'Jane Doe' WHERE id = 12;
SELECT om.assert(
  (SELECT count(*) FROM segments WHERE person_id = 12) = 40,
  'person 12 should have 40 segments'
);
```

An assertion can go anywhere in the file: before the changes as a
precondition, between them, or after them as a postcondition. `om.assert`
raises with its own SQLSTATE, so the harness tells a failed assertion (the
data isn't what the changeset expects) from any other error (a bug in the
SQL). Assertions express intent ("this person still has no slug"); the row
diff comparison catches the rest.

### Row identity

The agent writes ordinary SQL and never handles ids. A new row is referred to
however is natural: a CTE over `INSERT ... RETURNING`, a lookup by slug, or
`currval`.

Every check and every apply runs on main, so every new row's id comes from
main's sequences, and the references within one run are consistent. Across
runs a new row gets a different id, so the harness compares row diffs with
each inserted row's id replaced by a placeholder (`<new people 1>`), there and
in every foreign key column that points at it, found from the catalog.

Sequences are not transactional: an id drawn in a rolled-back check is used
up and never belongs to a committed row. So if an agent copies a new row's id
out of a check's output into `migration.sql`, the next check fails on the
foreign key. Every column that holds another row's id has a foreign key.

[Research](../docs/research/agent-changesets.md) covers how other systems
handle this, and a prototype that tests it.

### What a changeset may do

`migration.sql` changes data only. Schema changes stay in drizzle migrations.
The `changeset` role reads every table, and its column-level grants let it
insert and update only data columns: not `id`, not generated columns, not
columns filled by defaults such as `created_at`. It has `USAGE` on the
sequences, so defaults work, but not `UPDATE`, so it can't `setval`. It can't
run DDL, `TRUNCATE`, `SET ROLE` to another role, or
`session_replication_role` (which would disable the capture triggers).

The diff comparison ignores columns filled by `now()` defaults (eg
`chapter_generations.generated_at`).

### Domain invariants

The edit tools encode invariants that raw SQL can bypass: word onsets on
split and merged segments, chapters pointing at a generation, the transcript
fingerprint. Database constraints and `check_meeting` on the after state
catch most of these. The edit tools gain a mode that prints the SQL for an
edit instead of committing it, so an agent can generate statements for
`migration.sql` rather than writing them by hand.

### Lifecycle

draft → proposed → approved → applied, with conflicted, rejected and
superseded as the other outcomes.

## Alternatives considered

- **Keep committing edits per tool call.** No review, no unit of work, no
  testing before the data changes.
- **A database branch per changeset** (a Neon branch, or a copy made with
  `CREATE DATABASE ... TEMPLATE` or `pg_dump`). Gives a fixed before and an
  after the agent can open with any client, but ties the design to a provider
  with cheap branches or to copying the database. Copies can't use `TEMPLATE`
  on a live production database, which must be idle to be a template.
- **UUID keys.** They help when ids are minted in several disconnected
  places (branches, clones, offline clients). Here ids are minted only by
  main's sequences, so serial ids work.
- **Apply the approved row diff instead of replaying the SQL.** Each change
  is guarded by its row's approved before-image, and new rows keep the ids
  the check drew, which nobody else can have. It applies exactly what was
  reviewed. But it can't re-run the changeset's assertions, so an assumption
  about rows the changeset didn't touch goes unchecked. When main gains a row
  the SQL's `WHERE` would now match, it applies without that row, where replay
  flags a conflict.
- **Store only the SQL.** The same statements can change different rows on a
  moved main, and the reviewer would approve SQL, not its effect.
- **Preconditions in their own file.** The harness could run them alone, but
  inside a rolled-back transaction that saves nothing, and a separate file
  can't express checks between changes or after them.
- **Capture statements from the agent's session log.** Mixes exploration,
  failed attempts and reads into the record.
- **Postgres functions for edit operations** (`SELECT om.split_segment(...)`).
  Replays well and reads clearly, but duplicates domain logic in plpgsql. Worth
  revisiting if replay conflicts turn out to be common.

## Open questions

1. When main has moved: always require review again, or apply when the
   replayed diff still matches?
2. Is apply automatic on approval, or a separate step?
3. Do the golden fixtures (PSV files edited with psvtool) move to the same
   flow?
