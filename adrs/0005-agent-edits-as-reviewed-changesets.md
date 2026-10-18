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
3. Compute the row diff, run `check_meeting`, and answer the agent's queries
   (on after).
4. `ROLLBACK`

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
4. Compute the row diff and compare it to the approved one. A mismatch rolls
   back and marks the changeset conflicted.
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

### Stable references to new rows

Ids are `serial`. A row the changeset inserts can get a different id at apply
time than at check time. A literal reference to a new row's id is a bug:

```sql
INSERT INTO people (name) VALUES ('Jane Doe');          -- id 57 at check time
UPDATE segments SET person_id = 57 WHERE id IN (...);   -- another id at apply
```

New rows are referenced through `INSERT ... RETURNING` in a CTE, or by slug.

Sequences are not transactional: a rolled-back check still uses up the ids it
drew. So every check runs `migration.sql` twice, in two rolled-back
transactions. The second run's new rows get different ids, so a hardcoded id
points at a row that no longer exists and fails a foreign key, or shows up as
a difference between the two diffs. The diff comparison matches new rows by
content and relationships, not id.

### What a changeset may do

`migration.sql` changes data only. Schema changes stay in drizzle migrations.
It runs as a role that can only read, insert, update and delete on the data
tables and call `om.assert`: no DDL, `TRUNCATE`, `setval`, `SET ROLE` or
transaction control.

The diff comparison ignores columns filled by non-deterministic defaults (eg
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
- **Store only the row diff and apply it.** A diff is exact for the database
  it was computed on but has no intent to replay: it can't adapt to a main
  that has moved, and it overwrites concurrent changes to the same rows.
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
