#!/usr/bin/env bash
# Copies a Postgres database's public data into a new DuckDB file, for
# querying without Postgres; see skills/open-minutes-data/SKILL.md. The
# export-duckdb workflow runs it nightly on production and publishes the file.
# Usage: DATABASE_URL=postgres://... export-duckdb.sh <output .duckdb>
#
# Needs the duckdb CLI (`uvx --from duckdb-cli duckdb`, or pipx) on PATH. Only
# reads the source: it's attached READ_ONLY.
#
# The file is published to a public bucket, so tables are copied by name: a new
# table stays out until someone adds it here.
set -euo pipefail
out="$1"
: "${DATABASE_URL:?DATABASE_URL must be set}"

rm -f "$out" "$out.wal"
# The SQL goes in on stdin so the URL isn't in the process list. ATTACH takes
# only a string literal, so quotes in it are doubled.
duckdb "$out" <<SQL
INSTALL postgres;
LOAD postgres;
ATTACH '${DATABASE_URL//\'/\'\'}' AS pg (TYPE postgres, READ_ONLY);

-- Sorted by meeting, so a filter on meeting_id skips most of the file (DuckDB
-- keeps each column's min and max per row group), even read over HTTP.
CREATE TABLE jurisdictions AS FROM pg.public.jurisdictions ORDER BY id;
CREATE TABLE bodies AS FROM pg.public.bodies ORDER BY id;
-- Only meetings with a transcript: one added but not yet transcribed has
-- nothing to read.
CREATE TABLE meetings AS
  FROM pg.public.meetings WHERE transcribed_at IS NOT NULL ORDER BY id;
CREATE TABLE meeting_bodies AS
  FROM pg.public.meeting_bodies WHERE meeting_id IN (SELECT id FROM meetings)
  ORDER BY meeting_id, body_id;
-- DuckDB reads pgvector's vector as text, e.g. "[0.1,-0.2,...]".
CREATE TABLE people AS
  SELECT * REPLACE (voice_embedding::FLOAT[] AS voice_embedding)
  FROM pg.public.people ORDER BY id;
CREATE TABLE segments AS
  SELECT * REPLACE (words::JSON AS words) FROM pg.public.segments
  ORDER BY meeting_id, start_secs;
CREATE TABLE chapter_generations AS
  FROM pg.public.chapter_generations ORDER BY meeting_id, id;
CREATE TABLE chapters AS FROM pg.public.chapters ORDER BY meeting_id, start_secs;
CREATE TABLE chapter_speakers AS
  FROM pg.public.chapter_speakers ORDER BY meeting_id, chapter_id;

-- One row: when this was made and from which schema version.
CREATE TABLE export_info AS
  SELECT
    now() AS exported_at,
    (SELECT name FROM pg.drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1)
      AS latest_migration;

DETACH pg;
CHECKPOINT;
SQL
