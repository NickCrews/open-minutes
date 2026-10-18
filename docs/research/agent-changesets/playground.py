"""Times making a playground that holds one meeting: an empty database from
a schema-only template, then that meeting's rows copied from main with COPY.
Needs a database `big` (the main stand-in) and `om_schema` (schema only); see
../agent-changesets.md."""

import os
import time

import psycopg

S = os.environ.get("PROTO_PG", "host=localhost port=5499") + " user=postgres dbname="
t = time.time()
with psycopg.connect(S + "postgres", autocommit=True) as c:
    c.execute("DROP DATABASE IF EXISTS play1")
    c.execute("CREATE DATABASE play1 TEMPLATE om_schema")
t1 = time.time() - t
# In foreign key order: one meeting, every person, 2,000 of its segments, its chapters.
copies = [
    ("meetings", "SELECT * FROM meetings WHERE id = 1"),
    ("people", "SELECT * FROM people"),
    ("segments", "SELECT id, meeting_id, person_id, speaker_number, words, created_at FROM segments WHERE meeting_id = 1 AND id < 4000"),
    ("chapter_generations", "SELECT * FROM chapter_generations WHERE meeting_id = 1"),
    ("chapters", "SELECT * FROM chapters WHERE meeting_id = 1"),
]
with psycopg.connect(S + "big") as src, psycopg.connect(S + "play1") as dst:
    with dst.transaction():
        for tbl, q in copies:
            cols = "(id, meeting_id, person_id, speaker_number, words, created_at)" if tbl == "segments" else ""
            with src.cursor().copy(f"COPY ({q}) TO STDOUT (FORMAT binary)") as out, \
                 dst.cursor().copy(f"COPY {tbl} {cols} FROM STDIN (FORMAT binary)") as inp:
                for block in out:
                    inp.write(block)
        # Sequences continue from main's, so ids a playground draws look like main's.
        for seq, tbl in [("segments_id_seq", "segments"), ("people_id_seq", "people")]:
            v = src.execute(f"SELECT last_value FROM {seq}").fetchone()[0]
            dst.execute(f"SELECT setval('{seq}', {v})")
    n = dst.execute("SELECT count(*) FROM segments").fetchone()[0]
print(f"empty db from schema template: {t1:.2f}s; with one meeting ({n} segments): {time.time()-t:.2f}s")
