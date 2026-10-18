"""A prototype changeset harness: check, and two ways to apply.

check        run the changeset's SQL as the `changeset` role in a transaction
             that always rolls back, and return the row changes it made.
apply_replay run the SQL again on current main, and commit only if its row
             changes match the approved ones, with new-row ids and default
             timestamps factored out.
apply_diff   apply the approved row changes themselves, each update and
             delete guarded by the row's approved before-image, then verify
             every touched row ended as approved.
"""

import json
import os
import psycopg
from psycopg.rows import dict_row

# Server to run against, eg "host=localhost port=5432".
SERVER = os.environ.get("PROTO_PG", "host=localhost port=5499")
DSN = SERVER + " dbname={db} user={user}"


def connect(db, user="postgres"):
    return psycopg.connect(DSN.format(db=db, user=user), row_factory=dict_row)


class Rollback(Exception):
    pass


def check(db, sql):
    """Run sql, return {"ok", "error", "sqlstate", "log"}. Never commits."""
    with connect(db, "changeset") as c:
        try:
            with c.transaction():
                c.execute("SELECT om.run(%s)", [sql])
                log = c.execute(
                    "SELECT tbl, op, old, new FROM om.capture_log ORDER BY seq"
                ).fetchall()
                raise Rollback(log)
        except Rollback as r:
            return {"ok": True, "log": r.args[0]}
        except psycopg.Error as e:
            return {"ok": False, "sqlstate": e.sqlstate, "error": e.diag.message_primary}


# ------------------------------------------------------------------ catalog


def catalog(db):
    with connect(db) as c:
        gen = c.execute(
            """SELECT table_name, column_name FROM information_schema.columns
               WHERE table_schema = 'public' AND is_generated = 'ALWAYS'"""
        ).fetchall()
        nondet = c.execute(
            """SELECT table_name, column_name FROM information_schema.columns
               WHERE table_schema = 'public' AND column_default LIKE '%%now()%%'"""
        ).fetchall()
        # Single referencing column -> referenced table, for FKs onto `id`.
        fks = c.execute(
            """SELECT cl.relname AS tbl, a.attname AS col, rcl.relname AS ref
               FROM pg_constraint k
               JOIN pg_class cl ON cl.oid = k.conrelid
               JOIN pg_class rcl ON rcl.oid = k.confrelid
               JOIN LATERAL unnest(k.conkey, k.confkey) AS u(src, dst) ON true
               JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.src
               JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = u.dst
               WHERE k.contype = 'f' AND ra.attname = 'id'
                 AND cl.relnamespace = 'public'::regnamespace"""
        ).fetchall()
        cols = c.execute(
            """SELECT table_name, column_name FROM information_schema.columns
               WHERE table_schema = 'public' AND is_generated = 'NEVER'
               ORDER BY ordinal_position"""
        ).fetchall()
    cat = {"generated": {}, "nondet": {}, "fks": {}, "writable": {}}
    for r in gen:
        cat["generated"].setdefault(r["table_name"], set()).add(r["column_name"])
    for r in nondet:
        cat["nondet"].setdefault(r["table_name"], set()).add(r["column_name"])
    for r in fks:
        cat["fks"].setdefault(r["tbl"], {})[r["col"]] = r["ref"]
    for r in cols:
        cat["writable"].setdefault(r["table_name"], []).append(r["column_name"])
    return cat


# ------------------------------------------------------------------ diffs


def canonical(log, cat):
    """The log with new-row ids replaced by placeholders and default
    timestamps dropped, as a sorted list, so two runs of the same SQL on
    slightly different databases can be compared."""
    new_ids = {}
    for e in log:
        if e["op"] == "INSERT":
            key = (e["tbl"], e["new"]["id"])
            new_ids[key] = f"<new {e['tbl']} {len(new_ids) + 1}>"

    def fix(tbl, row):
        if row is None:
            return None
        out = {}
        for k, v in row.items():
            if k in cat["nondet"].get(tbl, ()):
                continue
            if k == "id":
                v = new_ids.get((tbl, v), v)
            elif k in cat["fks"].get(tbl, {}):
                v = new_ids.get((cat["fks"][tbl][k], v), v)
            out[k] = v
        return out

    return sorted(
        json.dumps(
            [e["tbl"], e["op"], fix(e["tbl"], e["old"]), fix(e["tbl"], e["new"])],
            sort_keys=True,
        )
        for e in log
    )


# ------------------------------------------------------------------ apply


def apply_replay(db, changeset_id, sql, approved_log):
    cat = catalog(db)
    approved = canonical(approved_log, cat)
    with connect(db, "changeset") as c:
        try:
            with c.transaction():
                c.execute("SELECT om.claim(%s)", [changeset_id])
                c.execute("SELECT om.run(%s)", [sql])
                log = c.execute(
                    "SELECT tbl, op, old, new FROM om.capture_log ORDER BY seq"
                ).fetchall()
                c.execute("SELECT om.clear_log()")  # the log is never committed
                got = canonical(log, cat)
                if got != approved:
                    extra = sorted(set(got) - set(approved))
                    missing = sorted(set(approved) - set(got))
                    raise Rollback(f"diff changed: +{len(extra)} -{len(missing)}")
        except Rollback as r:
            return {"applied": False, "reason": r.args[0]}
        except psycopg.Error as e:
            return {"applied": False, "reason": f"{e.sqlstate}: {e.diag.message_primary}"}
    return {"applied": True}


def apply_diff(db, changeset_id, approved_log):
    cat = catalog(db)
    with connect(db) as c:
        try:
            with c.transaction():
                c.execute("SELECT om.claim(%s)", [changeset_id])
                for e in approved_log:
                    # Each change moves a row from its before-image to its
                    # after-image. A row already at its after-image (eg deleted
                    # or nulled by a cascade replayed earlier) is skipped; a row
                    # in neither state has changed since the check.
                    t, cols = e["tbl"], cat["writable"][e["tbl"]]
                    collist = ", ".join(cols)
                    id_ = (e["new"] or e["old"])["id"]
                    cur = c.execute(
                        f"SELECT to_jsonb(t) AS r FROM {t} t WHERE id = %s FOR UPDATE", [id_]
                    ).fetchone()
                    cur = cur and cur["r"]
                    if cur == e["new"]:
                        continue
                    if cur != e["old"]:
                        raise Rollback(f"{t} {id_} changed since the check")
                    if e["op"] == "INSERT":
                        c.execute(
                            f"INSERT INTO {t} ({collist}) SELECT {collist} "
                            f"FROM jsonb_populate_record(null::{t}, %s)",
                            [json.dumps(e["new"])],
                        )
                    elif e["op"] == "UPDATE":
                        c.execute(
                            f"UPDATE {t} SET ({collist}) = (SELECT {collist} "
                            f"FROM jsonb_populate_record(null::{t}, %s)) WHERE id = %s",
                            [json.dumps(e["new"]), id_],
                        )
                    else:
                        c.execute(f"DELETE FROM {t} WHERE id = %s", [id_])
                # Every row the check touched, cascades included, ends as approved.
                final = {}
                for e in approved_log:
                    row = e["new"] if e["op"] != "DELETE" else None
                    final[(e["tbl"], (e["new"] or e["old"])["id"])] = row
                for (t, id_), want in final.items():
                    got = c.execute(
                        f"SELECT to_jsonb(t) AS r FROM {t} t WHERE id = %s", [id_]
                    ).fetchone()
                    got = got and got["r"]
                    if got != want:
                        raise Rollback(f"{t} {id_} did not end as approved")
        except Rollback as r:
            return {"applied": False, "reason": r.args[0]}
        except psycopg.Error as e:
            return {"applied": False, "reason": f"{e.sqlstate}: {e.diag.message_primary}"}
    return {"applied": True}
