# Agent changesets

A proposal for how agents edit the database: each agent's work is one SQL
file of data changes and assertions, checked against the database without
committing, and applied only after review. None of it is built. A prototype in
[`agent-changesets/`](agent-changesets/) tests the parts that carry the most
risk; its results are under [Row identity research](#row-identity-research).

Status: proposal, 2026-10-18.

## Motivation

Agents clean up meeting data: who said what, people, chapters, meeting
details. Today they do this only in golden fixture files
(`packages/datasets/datums/`), edited with `psvtool` and checked with
`pnpm datasets:check`. Editing the database directly needs a point between
"the agent decided" and "the data changed" where a human or another agent can
review the work, a record of a session's edits as one unit, and a way to test
a set of edits before it lands.

Agents also read untrusted input. Anyone can say anything during public
comment, including text written to steer an agent, and it reaches the agent
word for word in the transcript. So the harness, not the prompt, has to limit
what an agent can change, and a reviewer has to be able to catch an agent that
was steered.

## Proposal

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

### Checking

The harness computes after in a transaction that it always rolls back, on a
branch of main made for the check (see [Branches](#branches)):

1. `BEGIN`
2. Run `migration.sql`.
3. Read the row diff, run the meeting rules (`packages/core/src/rules/`),
   and answer the agent's queries (on after).
4. `ROLLBACK`

`migration.sql` runs on its own connection as the `changeset` role, inside
`om.run(sql)`, a plpgsql function that `EXECUTE`s it, where `COMMIT` and
`ROLLBACK` raise instead of ending the transaction.

The branch is made from main at the start of the check, so its before is
main's current state, and nothing the check does reaches main: not its locks,
not its CPU, not the sequence values it draws. Locally and in tests, where
copying a database is cheap only while nothing is connected to it, the
transaction can run on main itself, since a rolled-back transaction leaves no
data behind.

### Row diff

Every data table has an `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW`
trigger that appends to `om.capture_log`:

| column | content                                            |
| ------ | -------------------------------------------------- |
| `seq`  | order of the change                                |
| `tbl`  | table name                                         |
| `op`   | `INSERT`, `UPDATE` or `DELETE`                     |
| `old`  | the row before, as `to_jsonb(OLD)`; null on insert |
| `new`  | the row after, as `to_jsonb(NEW)`; null on delete  |

The trigger records only when `session_user` is `changeset`. A session can't
change its `session_user`, so the changeset's SQL can't turn capture off, and
every other session (ingest, the web app, the harness itself) pays one
comparison per row and writes nothing. Rows changed by a foreign key cascade
are captured too, as their own entries. The harness reads the log before the
transaction ends; it is rolled back with everything else, or, on apply,
cleared before the commit.

The row diff is that list of entries. A reviewer sees it rendered by table
and row, with changed columns highlighted.

To compare two row diffs (the approved one, and the one an apply produces),
the harness canonicalizes each:

1. Each inserted row's `id` becomes a placeholder numbered in insertion order
   per table (`<new people 1>`), there and in every foreign key column that
   holds it. Foreign keys come from the catalog.
2. Columns filled by a `now()` default (eg `created_at`) are dropped.
3. The entries are sorted, so the comparison doesn't depend on the order a
   single statement visited rows.

Two row diffs match when their canonical forms are equal.

### Branches

A branch is a copy of a whole database, made from main or from another branch,
that can be reset to how it was made and thrown away. On Neon, main's host, a
branch is copy-on-write: it takes about a second however large main is, and
costs storage only for what changes on it. Locally and in tests, a branch is a
`CREATE DATABASE ... TEMPLATE` copy, as test databases and per-git-branch
databases are today. One package covers both (see
[Implementation plan](#implementation-plan)).

The harness uses branches three ways:

- **Playgrounds**, for the agent to explore and try edits in.
- **Check branches**, made from main for each check and reset before the
  next.
- **PR previews**, as the preview workflow already does.

### Playgrounds

A playground is a branch the agent has total freedom in. It holds the whole
database, so the agent can ask questions across meetings, such as where else
someone named Bob Jones appears. The agent starts with one, `proposal`, made
from main when the session starts. These are its primitives:

- **SQL.** `sql [--db <playground>] '<query>'` runs any statement on a
  playground, as its owner. `sql --db main` is read-only.
- **Rules.** `om check [--db <playground>] [--meeting <slug>]...` checks
  meetings against the rules and prints the violations.
- **Playgrounds.**
  - `playground new <name> [--from <playground>]` makes a branch of main, or
    of another playground.
  - `playground reset <name>` puts it back as it was made.
  - `playground diff <name>` shows its row diff since it was made. The
    capture triggers come with the schema, and a setting on each playground
    makes them record every session's changes, not only `changeset`'s.
  - `playground list` and `playground rm <name>`.
- **Changesets.** `changeset check` runs `migration.sql` on a check branch
  (see [Checking](#checking)) and prints the first failed assertion if any,
  else a summary of the row diff and the change in rule violations (fixed and
  introduced). `changeset query '<sql>'` runs a query on the after state,
  inside the same rolled-back transaction.
- **Web.** `web_search` and `web_fetch`, for context the database doesn't
  have: who a person is, what a bill number refers to.

A playground never feeds main: the product is `migration.sql`, checked
against main.

### Agent UX

The agent is an ordinary coding agent (bash, read, write, edit) with the
primitives above. Its product is `migration.sql`, and optionally
`rationale.md`; the harness takes those files as the final product.

What we expect an agent to do with them:

1. Read the meeting in `proposal`, check it against the rules, and look up
   people and bills it mentions, in the database and on the web.
2. Try edits there with SQL, checking the rules as it goes. Reset `proposal`
   when an approach fails, or branch it with `--from` to try two side by
   side.
3. Write the edits that worked into `migration.sql`, using `om playground
   diff` to see what they changed.
4. Run `changeset check` until its assertions pass and it introduces no
   violations, then propose it.

The after state of `changeset check` is always rebuilt from the file, so the
file and the result can't drift apart.

A changeset covers one meeting or one task, so review stays manageable and
conflicts stay rare.

### Review

The reviewer, human or agent, reads the row diff, shown in domain terms (eg a
transcript with relabelled segments highlighted) rather than as SQL, alongside
the change in rule violations and the rationale. Approving applies the changeset
at once, against the row diff the reviewer saw.

A reviewer agent has the same primitives as the author, with its own
playgrounds. It doesn't see the author's session, so it
judges the edits rather than the argument for them, and text in the meeting
that steered the author doesn't reach it through the author's reasoning. It
uses a different model or prompt from the author, so the two share fewer
blind spots.

The reviewer approves or rejects the changeset as a whole, and its comments
point at individual changes, so one disputed relabel doesn't hide forty good
word fixes. The author revises `migration.sql` and re-checks, or replies. The
reviewer keeps its context across rounds, so it can check its requests were
addressed. After a fixed number of rounds, the author moves the changes still
disputed into a separate changeset that goes to a human, and the reviewer
approves or rejects the rest.

### Applying

Applying is a check that commits, and takes about as long:

1. `BEGIN`
2. Insert the changeset's row into a `changesets` table, keyed by its id. A
   second apply fails on the key, so double-apply is impossible.
3. Run `migration.sql`. A failed assertion rolls back and marks the
   changeset conflicted.
4. Compare the row diff to the approved one (see [Row diff](#row-diff)). A
   mismatch rolls back and marks the changeset conflicted.
5. `COMMIT`

If main changed since the check but the row diff still matches, the
changeset applies: it does exactly what the reviewer approved. If the
approval depended on rows the changeset doesn't change, the changeset says so
in an assertion. For example, chapters written from a transcript assert that
the meeting's transcript fingerprint is the one they were written from, and
naming a voice asserts which segments that voice has.

A conflicted changeset goes back to its author to re-check, and then to
review again.

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

Every run draws new rows' ids from the sequences of the database it runs on,
so the references within one run are consistent. Across runs a new row gets a
different id, which the row diff comparison factors out (see
[Row diff](#row-diff)).

Before each check, the harness advances every sequence on the check branch by
a random amount. So if an agent copies a new row's id out of a check's output
into `migration.sql`, the next check gives that row a different id and fails
on the foreign key. Every column that holds another row's id has a foreign
key. (Where a check runs on main itself, sequences need no help: an id drawn
in a rolled-back transaction is used up and never belongs to a committed
row.)

A check also confirms that the run drew exactly one sequence value per
inserted row. Without that, a changeset could hide
`SELECT nextval(...) FROM generate_series(...)`, which a row diff doesn't
show, and use up main's ids when applied.

[Row identity research](#row-identity-research) covers how other systems
handle this, and a prototype that tests it.

### What a changeset may do

`migration.sql` changes data only. Schema changes stay in drizzle migrations.
The `changeset` role reads every table, and its column-level grants let it
insert and update only data columns: not `id`, not generated columns, not
columns filled by defaults such as `created_at`. It has `USAGE` on the
sequences, so defaults work, but not `UPDATE`, so it can't `setval`. It can't
run DDL, `TRUNCATE`, `SET ROLE` to another role, or
`session_replication_role` (which would disable the capture triggers).

### Domain invariants

Edits carry invariants that raw SQL can bypass: word onsets on split and
merged segments, chapters pointing at a generation, the transcript
fingerprint. Database constraints and the meeting rules on the after state
catch most of these. Helpers that print the SQL for common edits (split,
merge, relabel) let an agent generate statements for `migration.sql` rather
than writing them by hand.

### Golden fixtures

The golden PSV files become snapshots of database state, exported from the
database. Agents don't edit them; they change the database through
changesets.

### Lifecycle

draft → proposed → applied. A proposed changeset goes back to draft when the
reviewer asks for changes or it conflicts on apply. It can instead end
rejected or superseded.

### Harness

The agent runs in [pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`), embedded with `createAgentSession` in a
host process. The host holds every credential: the Neon API key, the model's
API key, and the connection strings for main and the session's branches.

- **Sandbox.** pi's `bash`, `read`, `write` and `edit` tools run against
  [just-bash](https://github.com/vercel-labs/just-bash), a bash interpreter
  written in TypeScript with its own in-memory filesystem, wired in through
  pi's pluggable tool operations (`BashOperations`, `ReadOperations` and so
  on). The agent's commands start no processes and can't touch the host's
  files. Its workspace (`migration.sql`, `rationale.md`, notes) lives in that
  filesystem, and the host saves it when the session ends. just-bash brings
  the text tools: `grep`, `sed`, `awk`, `jq` and more.
- **Primitives as commands.** `sql`, `om check`, `playground` and `changeset`
  are just-bash custom commands (`defineCommand`), which run in the host. They
  hold the branch connections, so the agent uses databases without ever
  seeing a credential.
- **Web as pi tools.** `web_search` and `web_fetch`, registered with
  `pi.registerTool`, also run in the host.
- **Propose.** `propose` saves the workspace, runs a last check, stores the
  changeset, and ends the session.
- **Limits.** A `tool_call` hook enforces budgets (turns, tokens, checks,
  playgrounds, wall-clock time) and logs every call.
- **Teardown.** The host deletes the session's branches when it ends. Neon
  can't branch from a branch that has an expiry time, so playgrounds don't
  get one; instead a cleanup job deletes any `agent/*` branch older than a
  day, for sessions that crash.
- **Branch budget.** A session uses `proposal`, a check branch, and at most
  two more playgrounds. Neon's free plan allows 10 branches per project,
  shared with main and PR previews, so one or two sessions can run at a
  time.
- **Transcript.** pi's session file is kept with the changeset for audit. The
  reviewer doesn't see it.

The reviewer is a second session on the same harness, with comment, approve
and request-changes tools in place of `propose`.

### Threat model

Everything in the database is public: the transcripts, and the voices, come
from public recordings. So reading and exfiltration aren't risks. The risk is
bogus writes reaching main, from an agent steered by text in a meeting or on
a web page, or one that is simply wrong.

- Only an apply writes main. It applies only reviewed changesets, as the
  `changeset` role, with lock and statement timeouts.
- Checks, playgrounds and the agent's own SQL run on branches, so nothing
  short of an apply can lock main, load it, or use up its ids.
- The agent holds no credentials. Neon gives a child branch its parent's
  roles and passwords unless the parent is protected (a paid feature), so a
  branch's owner password also opens main. The host keeps it.
- The realistic worst case is a false or defamatory change, such as a wrong
  name or bio, that the reviewer agent misses. Changes to people's names and
  bios, and large deletes, need a person's approval.
- Backups restore main after a bogus write that gets through.
- Not done for now: protecting main's Neon branch (a paid plan), and an IP
  allowlist on the project.

### Alternatives considered

- **Commit each edit as the agent makes it.** No review, no unit of work, no
  testing before the data changes.
- **Playgrounds as schemas inside main's database.** Needs no `CREATEDB`, and
  copies are `INSERT ... SELECT` within one database. But `CREATE TABLE ...
  (LIKE ...)` copies neither foreign keys nor triggers, so the harness would
  recreate them per schema, and playground rows would land in production's
  backups.
- **Check in the agent's playground.** The playground drifts from main as
  the agent works in it, so a check there doesn't say what applying would do.
  A check branch is made from main for each check.
- **Playgrounds holding only the task's meetings**, copied into PGlite or a
  database on main's server. Cheaper per playground, but the agent can't ask
  questions across meetings.
- **A container for the agent's tools.** Isolates real processes, but the
  agent needs no binaries beyond SQL, the rules and text tools, which an
  in-process sandbox provides (see [Harness](#harness)) with nothing to
  provision.
- **An approved state between proposed and applied.** Applying takes as long
  as a check, so there is nothing to wait for between approving and applying.
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

## Implementation plan

Each step can merge on its own and is useful before the next one exists.

1. **Branches package.** Move branching out of `packages/db` into
   `packages/dbranch` (the name its CLI and `dbranch.config.ts` already use),
   behind one interface: make a branch from main or from another branch,
   get its connection URL, reset it, delete it, list branches by prefix. Two
   backends: local (`CREATE DATABASE ... TEMPLATE` on the docker-compose
   server, as `ensure.ts` and `testing/` do today) and Neon (its API, with a
   project-scoped key). Move test databases and per-git-branch databases onto
   the local backend, and the PR preview workflow onto the Neon backend
   through the CLI instead of inline `neonctl`. Nothing changes for users;
   done when CI and previews behave as before.
2. **Changeset schema.** A migration adding the `om` schema: `capture_log`
   and its trigger on every data table, `om.run`, `om.assert` with its own
   SQLSTATE, the `changesets` table, and the `changeset` group role with its
   column grants. The login role that applies changesets is created outside
   migrations, since its password can't live in one. Tests: every data table
   has the trigger, every column holding an id has a foreign key, and the
   role can't write ids, generated columns or default-filled columns, or get
   around its limits (ported from the prototype's `mistakes.py`). Inert on
   main: nothing is logged unless a changeset session writes.
3. **Changeset library.** `packages/changesets`: check a `migration.sql` on a
   branch (random sequence offsets, sequence draws counted, row diff read),
   canonicalize and match row diffs, and apply to main. The prototype's
   scenarios become its test suite, on test databases.
4. **Rules on a database.** Load a meeting from the database into the shape
   `packages/core/src/rules/` checks, `om check [--db]` to print violations,
   and a function that compares violations between two databases. Useful
   alone, to check ingested meetings and not only golden files.
5. **Changesets for people.** `pnpm changeset check <file>` and
   `pnpm changeset apply <file>`, which prints the row diff and asks for
   confirmation. A person can write and apply a data fix through the same
   path agents will use, before any agent exists. Decide here where proposed
   changesets live: a table in main, or files reviewed in GitHub pull
   requests.
6. **Agent harness.** `packages/agent`: the pi session, the just-bash
   sandbox, the custom commands, the web tools, budgets, teardown and
   `propose`. Runs against the local backend first, as
   `pnpm agent run --meeting <slug>`. Rewrites the transcript-cleanup and
   people-records skills for the database.
7. **Reviewer.** The second session, the review loop with its round limit,
   splitting disputed changes into their own changeset, and the human gate
   for names, bios and large deletes.
8. **Production.** A workflow that runs sessions against Neon within the
   branch budget, manually dispatched at first; the cleanup job for `agent/*`
   branches; applying on approval with the apply role's credentials; and a
   tested restore from backup before the first apply.

Steps 1 and 2 don't depend on each other, and step 4 depends on neither. Step
3 needs 1 and 2; steps 5 and 6 need 3 and 4.

## Row identity research

An agent's changeset is SQL that is checked now and applied later, after main
may have changed. This covers how rows keep their identity across that gap,
above all rows the changeset inserts, without the agent having to think about
ids. Tested 2026-10-18.

### The problem

Ids are `serial`. If a changeset is SQL text that names ids, a new row's id
is whatever the sequence hands out at the time the SQL runs:

```sql
INSERT INTO people (name) VALUES ('Jane Doe');          -- id 57 when checked
UPDATE segments SET person_id = 57 WHERE id IN (...);   -- another id when applied
```

The constraint: the harness may be complex, but the agent writing a changeset
must not have to manage ids.

### Prior art

| System                                                                                                         | Where new ids come from                                                                                                                                                                       | How a delayed change detects that data moved                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenStreetMap changesets](https://docs.ropensci.org/osmapiR/reference/osm_diff_upload_changeset.html)         | Editors give new objects negative placeholder ids; the server assigns real ids on upload and returns the old → new mapping.                                                                   | Every modified element carries the version it was based on; a stale version is rejected with 409 Conflict.                                            |
| [MusicBrainz edits](https://musicbrainz-docs-development.readthedocs.io/en/latest/terminology/terms/edit.html) | Server-side, when the edit is applied.                                                                                                                                                        | Edits wait for votes, then fail with "failed prerequisite" if another edit changed the data first, or "failed dependency" if the entity is gone.      |
| [Datomic](https://docs.datomic.com/transactions.html)                                                          | Transactions use temporary ids; the transactor resolves them and returns a `:tempids` map. Every use of one tempid within a transaction is the same new entity.                               | Compare-and-swap (`:db/cas`) on the values the change depends on.                                                                                     |
| [Replicache](https://doc.replicache.dev/concepts/how-it-works)                                                 | Client-generated, passed into mutators as arguments, because unconfirmed mutators are replayed on top of new server state ("much like a git rebase") and must produce the same ids each time. | The server re-runs the mutator against current state; its result replaces the client's guess.                                                         |
| [Dolt](https://www.dolthub.com/blog/2023-10-27-uuid-keys/)                                                     | Recommends UUID keys over `AUTO_INCREMENT`: two branches, or two clones, hand out the same integer to different rows, which conflicts on merge.                                               | Cell-level three-way merge, matching rows by primary key.                                                                                             |
| [Postgres logical replication](https://www.postgresql.org/docs/18/logical-replication-conflicts.html)          | The publisher's ids are copied as-is.                                                                                                                                                         | Applies row images by key. A missing row for an update or delete is a logged conflict (`update_missing`, `delete_missing`) and the change is skipped. |

Two patterns:

- **Ids minted in one place, at the time of the change.** OSM, MusicBrainz
  and Datomic: the author never picks an id; placeholders resolve when the
  change lands.
- **Ids minted in many places.** Dolt and Replicache: ids are created on
  branches, clones or clients that don't talk to each other, so they must be
  globally unique (UUIDs) or passed in so replays agree.

Open Minutes' checks run on main itself, in a transaction that rolls back, so
it is in the first group: every id comes from main's sequences. UUIDs solve a
problem it doesn't have.

The useful facts about Postgres sequences:

- `nextval` is not transactional. An id drawn in a rolled-back transaction is
  used up and is never handed out again.
- So an id seen in one check's output never belongs to a committed row.

### Prototype

[`agent-changesets/`](agent-changesets/) is a working harness over a cut-down
copy of the schema (people, segments with generated columns, chapter
generations and chapters with a composite foreign key, and a cascading
table).

- **Capture.** An `AFTER` row trigger on each data table writes the old and
  new row as JSON to `om.capture_log`. It records only when `session_user` is
  the `changeset` role, which SQL in that session can't change.
- **Check.** The changeset's SQL runs as `changeset` inside
  `om.run(sql)` (a plpgsql function that `EXECUTE`s it), in a transaction
  that reads the log and rolls back.
- **Privileges.** `changeset` reads everything and can insert or update only
  data columns, by column-level grants: not `id`, not generated columns, not
  timestamps filled by defaults. It has `USAGE` on sequences, so defaults work,
  but not `UPDATE`, so no `setval`.
- **Apply by replay.** Run the SQL again as `changeset` on current main, and
  commit only if its row changes equal the approved ones after
  canonicalizing: each inserted row's id becomes a placeholder (`<new people
  1>`) wherever it appears, including foreign key columns found from the
  catalog, and columns with a `now()` default are dropped.
- **Apply by diff.** Apply the approved row changes themselves, as a
  privileged role. Each change moves a row from its before-image to its
  after-image: a row already at its after-image is skipped (a cascade got
  there first), a row at neither is a conflict. Then every touched row must
  end as approved. New rows keep the ids the check drew, which nobody else
  can have.
- **Double-apply.** Both applies insert the changeset's id into
  `om.changesets` in the applying transaction.

#### Changesets, written without regard to ids

- **new person (CTE):** `WITH p AS (INSERT INTO people ... RETURNING id)
  UPDATE segments SET person_id = (SELECT id FROM p) WHERE meeting_id = 1 AND
  speaker_number = 3`.
- **new person (by slug):** insert, then `UPDATE ... SET person_id = (SELECT
  id FROM people WHERE slug = 'bob-jones') WHERE id IN (3, 5)`.
- **new person (currval):** insert, then `SET person_id =
  currval('people_id_seq')`.
- **split segment:** insert a copy of segment 4 with its last words, trim
  segment 4.
- **replace chapters:** delete meeting 1's chapters, insert a generation and
  three chapters pointing at it through a CTE.
- **merge people:** assert person 3 is still anonymous, move their segments to
  person 2, delete person 3 (cascading to their notes).

#### Results

Each changeset was checked, then main was changed by an admin connection, then
the changeset was applied. After every successful apply, a query confirmed
the intended end state, and a second apply was confirmed to fail.

Everything applied correctly, in both modes, except:

| Changeset        | Change to main between check and apply | Replay                                       | Diff                                   |
| ---------------- | -------------------------------------- | -------------------------------------------- | -------------------------------------- |
| new person (all) | someone else took slug `bob-jones`     | conflict: unique violation                   | conflict: unique violation             |
| new person (CTE) | a new speaker-3 segment in meeting 1   | conflict: the SQL now matches one more row   | applied, leaving the new segment as-is |
| split segment    | segment 4 re-transcribed               | conflict: diff changed                       | conflict: segment 4 changed            |
| merge people     | segment 4 re-transcribed               | conflict: diff changed                       | conflict: segment 4 changed            |
| merge people     | a new segment for person 3             | conflict: the SQL now moves one more segment | conflict: foreign key violation        |
| merge people     | person 3 named                         | conflict: the assertion failed               | conflict: person 3 changed             |

"Unrelated inserts" (new people, segments and a chapter generation, which
advance every sequence) applied correctly for every changeset in both modes,
including all three ways of referring to a new person.

#### Agent mistakes and escapes

| Changeset SQL                                                                  | Result                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Hardcodes a new person's id read from an earlier check's output                | Fails at the next check: foreign key violation, since that id is used up |
| `INSERT INTO people (id, ...)` with a guessed id                               | permission denied                                                        |
| `COMMIT;` or `ROLLBACK;`                                                       | EXECUTE of transaction commands is not implemented                       |
| `SET ROLE postgres`                                                            | permission denied                                                        |
| `RESET ROLE`                                                                   | allowed, and harmless: the session user is still `changeset`             |
| `SET session_replication_role = replica` (disables triggers)                   | permission denied                                                        |
| `ALTER TABLE ... DISABLE TRIGGER`, `DROP TABLE`, `CREATE TABLE`                | must be owner / permission denied                                        |
| `setval`, `TRUNCATE`, writing `created_at`, writing `om.*`, writing `meetings` | permission denied                                                        |
| `CREATE TEMP TABLE`                                                            | allowed (revoke `TEMPORARY` to forbid)                                   |

Every column in the real schema that holds another row's id has a foreign
key, so a hardcoded id is always caught.

#### Performance

On a 200,000-row `segments` table:

| Operation                                           | Time  |
| --------------------------------------------------- | ----- |
| Check: relabel 5,000 segments                       | 0.27s |
| Check: insert 5,000 segments                        | 0.29s |
| Apply by replay: relabel 5,000 segments             | 0.55s |
| Apply by diff: 5,000 updates, one round trip each   | 4.2s  |
| The same update as an admin (capture trigger skips) | 0.06s |

The diff apply would be set-based in a real harness.

### Conclusions

- **Agents need not handle ids.** Every check and apply draws ids from main's
  sequences, so references within one run are consistent whatever form the
  SQL takes. The harness owns identity across runs: replay factors new-row
  ids out of the comparison; diff reuses the ids the check drew. Column
  grants stop agents writing ids, and foreign keys catch a hardcoded one at
  the next check.
- **UUID keys aren't needed** for this. They help when ids are minted in
  several disconnected places; here they are minted only by main.
- **Replay versus diff.** They agree everywhere except when main gains a row
  that the SQL's `WHERE` would now match. Replay flags it for review (and
  would have included the row); diff applies exactly what was reviewed and
  leaves the new row out. Replay also re-runs the changeset's assertions at
  apply time; diff only checks the rows it touches, so an assumption about
  other rows goes unchecked. Replay's surprises fail safe, as a conflict.
- **Replay's canonical comparison matches new rows by insertion order.** An
  `INSERT ... SELECT` without `ORDER BY` could insert in a different order on
  a later run and produce a false conflict. That fails safe too.
- **Capture is cheap and needs no branch.** For other sessions, a trigger
  gated on `session_user` costs one comparison per row and writes nothing,
  and the log lives only inside the transaction.

### Playground timings

Agents also want scratch databases to explore in. Two ways to make one,
timed on the same machine, with a main stand-in of 532 MB (2,000,000
segments):

| Method                                                                                 | Time | Works while main has connections |
| -------------------------------------------------------------------------------------- | ---- | -------------------------------- |
| `CREATE DATABASE ... TEMPLATE main STRATEGY WAL_LOG` (the default)                     | 8.7s | no                               |
| `CREATE DATABASE ... TEMPLATE main STRATEGY FILE_COPY`                                 | 5.7s | no                               |
| Empty database from a schema-only template, then one meeting's rows copied with `COPY` | 0.4s | yes                              |
| `DROP DATABASE` of a full copy                                                         | 0.7s |                                  |

- `TEMPLATE` fails with "source database is being accessed by other users"
  when anything else is connected, so it can't copy a live main. It can copy
  an idle snapshot of main, or a playground between the agent's commands.
- Whole-database copies grow with main. The scoped copy grows with the
  meeting: it copies one meeting's segments and chapters, plus every person,
  in foreign key order, keeping ids, and needs only a read connection to
  main.
- [`playground.py`](agent-changesets/playground.py) times the scoped copy.

## Running the prototype

Needs a Postgres 16+ server you can drop databases on, with a `changeset`
login role, and Python with psycopg:

```sh
psql -h localhost -p 5499 -U postgres -c "CREATE ROLE changeset LOGIN" -c "CREATE DATABASE om_base"
psql -h localhost -p 5499 -U postgres -d om_base -f docs/research/agent-changesets/schema.sql
pip install "psycopg[binary]"
cd docs/research/agent-changesets
PROTO_PG="host=localhost port=5499" python scenarios.py   # results table
python mistakes.py                                         # mistakes and escapes
python perf.py                                             # timings
```

For `playground.py`, make `big` from `om_base` and fill `segments` (as
`perf.py` does), then `om_schema` with `pg_dump --schema-only big | psql -d
om_schema`.

`scenarios.py` makes a database per case from the `om_base` template.
