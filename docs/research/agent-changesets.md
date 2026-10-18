# Agent changesets: row identity between check and apply

Research behind [ADR 0005](../../adrs/0005-agent-edits-as-reviewed-changesets.md).
An agent's changeset is SQL that is checked now and applied later, after main
may have changed. This covers how rows keep their identity across that gap,
above all rows the changeset inserts, without the agent having to think about
ids. Tested 2026-10-18.

## The problem

Ids are `serial`. If a changeset is SQL text that names ids, a new row's id
is whatever the sequence hands out at the time the SQL runs:

```sql
INSERT INTO people (name) VALUES ('Jane Doe');          -- id 57 when checked
UPDATE segments SET person_id = 57 WHERE id IN (...);   -- another id when applied
```

The constraint: the harness may be complex, but the agent writing a changeset
must not have to manage ids.

## Prior art

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

## Prototype

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

### Changesets, written without regard to ids

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

### Results

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

### Agent mistakes and escapes

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

### Performance

On a 200,000-row `segments` table:

| Operation                                           | Time  |
| --------------------------------------------------- | ----- |
| Check: relabel 5,000 segments                       | 0.27s |
| Check: insert 5,000 segments                        | 0.29s |
| Apply by replay: relabel 5,000 segments             | 0.55s |
| Apply by diff: 5,000 updates, one round trip each   | 4.2s  |
| The same update as an admin (capture trigger skips) | 0.06s |

The diff apply would be set-based in a real harness.

## Conclusions

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

## Playgrounds

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
