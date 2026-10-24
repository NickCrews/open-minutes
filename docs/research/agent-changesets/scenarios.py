"""Changesets written the way an agent would, without thinking about ids,
checked, then applied after main changes in various ways."""

import itertools
import harness as h

counter = itertools.count()


def fresh_db():
    n = next(counter)
    name = f"t{n}"
    with h.psycopg.connect(h.SERVER + " dbname=postgres user=postgres", autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "t{n - 1}"')
        c.execute(f"DROP DATABASE IF EXISTS {name}")
        c.execute(f"CREATE DATABASE {name} TEMPLATE om_base")
    return name


def admin(db, sql):
    with h.connect(db) as c:
        c.execute(sql)


CHANGESETS = {
    # Name the speaker-3 voice as a new person (CTE).
    "new person (CTE)": """
        WITH p AS (INSERT INTO people (slug, name) VALUES ('bob-jones', 'Bob Jones') RETURNING id)
        UPDATE segments SET person_id = (SELECT id FROM p)
        WHERE meeting_id = 1 AND speaker_number = 3;
    """,
    # Same, as two statements, finding the new row by slug.
    "new person (by slug)": """
        INSERT INTO people (slug, name) VALUES ('bob-jones', 'Bob Jones');
        UPDATE segments SET person_id = (SELECT id FROM people WHERE slug = 'bob-jones')
        WHERE id IN (3, 5);
    """,
    # Same, with currval.
    "new person (currval)": """
        INSERT INTO people (slug, name) VALUES ('bob-jones', 'Bob Jones');
        UPDATE segments SET person_id = currval('people_id_seq') WHERE id IN (3, 5);
    """,
    # Split segment 4 after "one.": the second half is a new segment.
    "split segment": """
        INSERT INTO segments (meeting_id, person_id, speaker_number, words)
        SELECT meeting_id, person_id, speaker_number, words - 0 - 0
        FROM segments WHERE id = 4;
        UPDATE segments SET words = words - 4 - 3 - 2 WHERE id = 4;
    """,
    # Replace meeting 1's chapters with a new generation's.
    "replace chapters": """
        DELETE FROM chapters WHERE meeting_id = 1;
        WITH g AS (INSERT INTO chapter_generations (meeting_id, model) VALUES (1, 'human') RETURNING id)
        INSERT INTO chapters (meeting_id, generation_id, start_secs, end_secs, title)
        SELECT 1, g.id, s, e, t FROM g,
          (VALUES (0, 2, 'Call to order'), (2, 6, 'Roll call'), (6, 10, 'Item one')) AS c(s, e, t);
    """,
    # Merge voice 3 into voice 2. Deleting 3 cascades to its notes.
    "merge people": """
        SELECT om.assert(EXISTS (SELECT 1 FROM people WHERE id = 3 AND slug IS NULL), 'person 3 is still anonymous');
        UPDATE segments SET person_id = 2 WHERE person_id = 3;
        DELETE FROM people WHERE id = 3;
    """,
}

# What must hold after a successful apply.
VERIFY = {
    "new person (CTE)": "SELECT bool_and(s.person_id = p.id) FROM segments s, people p WHERE p.slug = 'bob-jones' AND s.id IN (3, 5)",
    "new person (by slug)": "SELECT bool_and(s.person_id = p.id) FROM segments s, people p WHERE p.slug = 'bob-jones' AND s.id IN (3, 5)",
    "new person (currval)": "SELECT bool_and(s.person_id = p.id) FROM segments s, people p WHERE p.slug = 'bob-jones' AND s.id IN (3, 5)",
    "split segment": "SELECT (SELECT text FROM segments WHERE id = 4) = 'Item one.' AND EXISTS (SELECT 1 FROM segments WHERE text = 'Second by Jones.' AND person_id = 3 AND meeting_id = 1)",
    "replace chapters": "SELECT array_agg(c.title ORDER BY c.start_secs) = '{Call to order,Roll call,Item one}' AND bool_and(g.model = 'human') FROM chapters c JOIN chapter_generations g ON g.id = c.generation_id WHERE c.meeting_id = 1",
    "merge people": "SELECT NOT EXISTS (SELECT 1 FROM people WHERE id = 3) AND NOT EXISTS (SELECT 1 FROM segments WHERE person_id = 3) AND NOT EXISTS (SELECT 1 FROM people_notes WHERE person_id = 3)",
}

# What happens on main between the check and the apply, run as an admin
# connection (not captured), the way ingest or another apply would.
INTERFERENCE = {
    "nothing": None,
    "unrelated inserts": """
        INSERT INTO people (name) VALUES ('Other'), ('Other 2');
        INSERT INTO segments (meeting_id, speaker_number, words) VALUES (2, 2, '[{"w":"Hi.","s":3}]');
        INSERT INTO chapter_generations (meeting_id, model) VALUES (2, 'model-a');
    """,
    "new speaker-3 segment in m1": """
        INSERT INTO segments (meeting_id, speaker_number, words) VALUES (1, 3, '[{"w":"Aye.","s":11}]');
    """,
    "segment 4 re-transcribed": """
        UPDATE segments SET words = '[{"w":"Item","s":6},{"w":"won.","s":6.3},{"w":"Second","s":7},{"w":"by","s":7.4},{"w":"Jones.","s":7.6}]' WHERE id = 4;
    """,
    "bob-jones taken": """
        INSERT INTO people (slug, name) VALUES ('bob-jones', 'Robert Jones');
    """,
    "new segment for person 3": """
        INSERT INTO segments (meeting_id, person_id, speaker_number, words) VALUES (2, 3, 1, '[{"w":"Thanks.","s":5}]');
    """,
    "person 3 named": """
        UPDATE people SET slug = 'carol-cho', name = 'Carol Cho' WHERE id = 3;
    """,
}


def run(name, sql, interference, approach):
    db = fresh_db()
    chk = h.check(db, sql)
    if not chk["ok"]:
        return f"check failed: {chk['sqlstate']} {chk['error']}"
    if INTERFERENCE[interference]:
        admin(db, INTERFERENCE[interference])
    if approach == "replay":
        res = h.apply_replay(db, "cs-1", sql, chk["log"])
    else:
        res = h.apply_diff(db, "cs-1", chk["log"])
    if not res["applied"]:
        return "conflict: " + res["reason"]
    with h.connect(db) as c:
        ok = list(c.execute(VERIFY[name]).fetchone().values())[0]
    if not ok:
        return "APPLIED WRONG RESULT"
    # A second apply must fail.
    again = (h.apply_replay(db, "cs-1", sql, chk["log"]) if approach == "replay"
             else h.apply_diff(db, "cs-1", chk["log"]))
    assert not again["applied"] and "changesets_pkey" in again["reason"], again
    return "applied"


if __name__ == "__main__":
    for name, sql in CHANGESETS.items():
        print(f"\n## {name}")
        for inter in INTERFERENCE:
            r = run(name, sql, inter, "replay")
            d = run(name, sql, inter, "diff")
            print(f"  {inter:28} replay: {r:60.60} | diff: {d:.60}")
