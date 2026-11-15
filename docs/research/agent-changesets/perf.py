import time, harness as h
from scenarios import fresh_db, admin
db = fresh_db()
admin(db, """INSERT INTO segments (meeting_id, speaker_number, words)
  SELECT 1 + (g % 2), g % 7, jsonb_build_array(jsonb_build_object('w', 'word' || g, 's', g)) FROM generate_series(1, 200000) g""")
for n, sql in [
  ("relabel 5,000 segments", "UPDATE segments SET speaker_number = 99 WHERE id BETWEEN 1000 AND 5999;"),
  ("insert 5,000 segments", "INSERT INTO segments (meeting_id, speaker_number, words) SELECT 1, 1, '[{\"w\":\"x\",\"s\":1}]' FROM generate_series(1, 5000);"),
]:
    t = time.time(); chk = h.check(db, sql); tc = time.time() - t
    t = time.time(); r = h.apply_replay(db, n + "r", sql, chk["log"]); tr = time.time() - t
    print(f"{n}: check {tc:.2f}s, replay apply {tr:.2f}s {r}")
db2 = fresh_db()
admin(db2, """INSERT INTO segments (meeting_id, speaker_number, words)
  SELECT 1 + (g % 2), g % 7, jsonb_build_array(jsonb_build_object('w', 'word' || g, 's', g)) FROM generate_series(1, 200000) g""")
sql = "UPDATE segments SET speaker_number = 99 WHERE id BETWEEN 1000 AND 5999;"
chk = h.check(db2, sql)
t = time.time(); r = h.apply_diff(db2, "d", chk["log"]); print(f"diff apply 5,000 updates: {time.time()-t:.2f}s {r}")
t = time.time(); admin(db2, "UPDATE segments SET speaker_number = 1 WHERE id BETWEEN 10000 AND 14999"); print(f"same update as admin, capture skipped: {time.time()-t:.2f}s")
