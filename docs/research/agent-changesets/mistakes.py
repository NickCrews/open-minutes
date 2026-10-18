"""What an agent can get wrong, or try to get around."""
import harness as h
from scenarios import fresh_db

db = fresh_db()

# 1. The agent checks once, reads the new person's id from the diff, then
#    hardcodes it in the next version of the file.
first = h.check(db, "INSERT INTO people (slug, name) VALUES ('bob-jones', 'Bob Jones');")
seen = first["log"][0]["new"]["id"]
second = h.check(db, f"""
    INSERT INTO people (slug, name) VALUES ('bob-jones', 'Bob Jones');
    UPDATE segments SET person_id = {seen} WHERE id IN (3, 5);
""")
print(f"hardcoded id {seen} seen in an earlier check:", second.get("sqlstate"), second.get("error"))

# 2. The agent guesses the next id from max(id) and writes it explicitly.
print("explicit id:", h.check(db, "INSERT INTO people (id, slug) VALUES (100, 'x');").get("error"))

# 3. Escapes.
for sql in [
    "COMMIT;",
    "ROLLBACK;",
    "RESET ROLE; UPDATE people SET name = 'x' WHERE id = 1;",
    "SET ROLE postgres;",
    "SET session_replication_role = replica;",
    "ALTER TABLE people DISABLE TRIGGER om_capture;",
    "SELECT setval('people_id_seq', 1);",
    "TRUNCATE chapters;",
    "DROP TABLE chapters;",
    "CREATE TABLE public.x (id int);",
    "UPDATE people SET created_at = now() - interval '1 year' WHERE id = 1;",
    "DELETE FROM om.capture_log;",
    "UPDATE om.changesets SET id = 'x';",
    "INSERT INTO meetings (slug, title) VALUES ('m3', 'x');",
    "CREATE TEMP TABLE x AS SELECT 1; ",
]:
    r = h.check(db, sql)
    print(f"{sql:60} -> {'ALLOWED' if r['ok'] else r['error']}")
