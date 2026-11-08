#!/usr/bin/env bash
# Dumps a Postgres database in pg_dump's custom format, and counts every
# table's rows in the same snapshot, so a restore of the dump must have exactly
# those counts. The backup-db workflow runs it on production.
# Usage: DATABASE_URL=postgres://... backup-db.sh <dump file> <counts file>
#
# Needs psql and pg_dump at least as new as the server. Only reads: the dump
# and the counts share one read-only transaction, whose snapshot pg_dump joins
# with --snapshot. That needs a direct connection, not a pooled one.
set -euo pipefail
dump=$(realpath -m "$1")
counts=$(realpath -m "$2")
: "${DATABASE_URL:?DATABASE_URL must be set}"
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A psql session that holds the transaction open while pg_dump runs. It writes
# the snapshot's id to a file, renamed into place once complete.
coproc SESSION { psql -X -q -At -v ON_ERROR_STOP=1 "$DATABASE_URL" >"$work/session.log" 2>&1; }
# Bash unsets SESSION_PID once the session exits, so keep a copy.
session_pid=$SESSION_PID
exec {to_session}>&"${SESSION[1]}"
cat >&"$to_session" <<SQL
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\o $work/snapshot.tmp
SELECT pg_export_snapshot();
\o
\! mv $work/snapshot.tmp $work/snapshot
SQL

for _ in $(seq 120); do
  [[ -f $work/snapshot ]] && break
  if ! kill -0 "$session_pid" 2>/dev/null; then
    cat "$work/session.log" >&2
    echo "The psql session exited before exporting a snapshot." >&2
    exit 1
  fi
  sleep 0.5
done
[[ -f $work/snapshot ]] || { echo "Timed out waiting for a snapshot." >&2; exit 1; }
snapshot=$(<"$work/snapshot")

pg_dump --format=custom --snapshot="$snapshot" --file="$dump" "$DATABASE_URL"

cat >&"$to_session" <<SQL
\o $counts
\i $here/db-row-counts.sql
\o
COMMIT;
\q
SQL
exec {to_session}>&-
if ! wait "$session_pid"; then
  cat "$work/session.log" >&2
  echo "Counting rows failed." >&2
  exit 1
fi
[[ -s $counts ]] || { echo "No tables were counted." >&2; exit 1; }
