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

An agent's work product is a **changeset**: a SQL file of data changes, plus
preconditions, written on a branch of the database and applied to main only
after review.

### Data model

- **Main** is the current database state.
- An agent works on one changeset against a **branch** of main taken at a
  recorded **base** snapshot.
- A changeset holds:
  - `migration.sql`: the Postgres statements to apply, in order.
  - `preconditions.sql`: optional queries that must hold before applying.
  - `rationale.md`: optional notes for the reviewer.
  - The base it was written against.
  - The **row diff**: the rows `migration.sql` inserted, updated and deleted
    when run on the base.
- Changesets are kept as the audit trail, whatever their outcome.

### Agent UX

The agent is an ordinary coding agent (bash, read, write, edit). It writes
`migration.sql` and `preconditions.sql`. The harness takes those files as the
final product.

The agent has two databases:

- **Scratch**: a branch it can query and change freely while exploring.
- **After**: rebuilt by the harness from the base plus `migration.sql` on
  every check. Only this one counts, so the files and the result can't drift
  apart.

One command (eg `om changeset check`):

1. Runs the preconditions on the base.
2. Rebuilds after.
3. Prints a summary of the row diff.
4. Prints the change in `check_meeting` results: issues fixed and issues
   introduced.

The agent also has read-only access to the base and after databases, and
keeps the read-only tools (transcript, people, audio).

A changeset covers one meeting or one task, so review stays manageable and
conflicts stay rare.

### Review

The reviewer, human or agent, reads the row diff, shown in domain terms (eg a
transcript with relabelled segments highlighted) rather than as SQL, alongside
the `check_meeting` change and the rationale. An approval binds to the base,
the hash of `migration.sql` and the hash of the row diff.

### Applying

In one transaction on current main:

1. Insert the changeset's row into a `changesets` table, keyed by its id. A
   second apply fails on the key, so double-apply is impossible.
2. Run `preconditions.sql`. Any failure aborts.
3. Run `migration.sql`.
4. Compute the row diff and compare it to the approved one. A mismatch rolls
   back and marks the changeset conflicted, needing review again.
5. Commit.

If main hasn't moved since the base, step 4 holds trivially.

### Preconditions

Each precondition is a query that returns the rows breaking it; zero rows
passes. Returning rows instead of a boolean makes a failure explain itself.
Preconditions express intent ("this person still has no slug"); the row diff
comparison catches the rest.

### Stable references to new rows

Ids are `serial`. Rows that exist at the base have the same id on the branch
and on main, but a row the changeset inserts can get a different id on main.
A literal reference to a new row's id is a bug:

```sql
INSERT INTO people (name) VALUES ('Jane Doe');          -- id 57 on the branch
UPDATE segments SET person_id = 57 WHERE id IN (...);   -- another id on main
```

New rows are referenced through `INSERT ... RETURNING` in a CTE, or by slug.
The harness advances every sequence on the scratch and after databases far
past main's (eg by 10,000,000), so a hardcoded new id fails a foreign key or
shows up as a diff mismatch when replayed. The diff comparison matches new
rows by content and relationships, not id.

### What a changeset may do

`migration.sql` changes data only. Schema changes stay in drizzle migrations.
It runs as a role that can only insert, update and delete on the data tables:
no DDL, `TRUNCATE`, `setval`, `SET ROLE` or transaction control.

The diff comparison ignores columns filled by non-deterministic defaults (eg
`chapter_generations.generated_at`).

### Domain invariants

The edit tools encode invariants that raw SQL can bypass: word onsets on
split and merged segments, chapters pointing at a generation, the transcript
fingerprint. Database constraints and `check_meeting` on the after state
catch most of these. The edit tools gain a mode that prints the SQL for an
edit instead of committing it, so an agent can generate statements for
`migration.sql` rather than writing them by hand.

### Branching

Production is on Neon, and each changeset's branch is a Neon branch, whose
branch point is the base. Local databases use `CREATE DATABASE ... TEMPLATE`
as `pnpm db` does today.

### Lifecycle

draft → proposed → approved → applied, with conflicted, rejected and
superseded as the other outcomes.

## Alternatives considered

- **Keep committing edits per tool call.** No review, no unit of work, no
  testing before the data changes.
- **Store only the row diff and apply it.** A diff is exact for the base but
  has no intent to replay: it can't adapt to a main that has moved, and it
  overwrites concurrent changes to the same rows.
- **Store only the SQL.** The same statements can change different rows on a
  moved main, and the reviewer would approve SQL, not its effect.
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
