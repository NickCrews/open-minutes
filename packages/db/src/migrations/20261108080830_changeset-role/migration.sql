-- Hand-written. The `changeset` role, which `pnpm transcript run` runs a
-- changeset's SQL as (see packages/edit/README.md), and what it needs:
--
-- - `changeset` reads the data tables, inserts, updates and deletes segments,
--   updates the slug, name and bio of people and the slug and title of
--   meetings, and calls the om functions. It owns nothing but om.run and can't
--   create anything outside pg_temp.
-- - om.run(sql) executes a changeset's SQL. It is SECURITY DEFINER and owned
--   by `changeset`, so the SQL runs as `changeset` and can't SET ROLE back.
-- - om.changes logs the rows `changeset` inserts, updates and deletes in
--   segments, chapters, meetings and people, so `run` can tell which meetings
--   a changeset touched. Its trigger function is SECURITY DEFINER, so
--   `changeset` can't write the log itself.
--
-- Roles belong to the whole server, so the role may already exist (another
-- database on it, or this one before a wipe). Whoever runs the migrations is
-- made a member, to SET ROLE to it.
DO $$
BEGIN
  BEGIN
    CREATE ROLE changeset NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
  IF NOT pg_has_role(current_user, 'changeset', 'SET') THEN
    EXECUTE format('GRANT changeset TO %I', current_user);
  END IF;
END $$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public, om TO changeset;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO changeset;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO changeset;--> statement-breakpoint
GRANT INSERT (meeting_id, person_id, speaker_number, words),
  UPDATE (meeting_id, person_id, speaker_number, words), DELETE
  ON segments TO changeset;--> statement-breakpoint
GRANT USAGE ON SEQUENCE segments_id_seq TO changeset;--> statement-breakpoint
GRANT UPDATE (slug, name, bio) ON people TO changeset;--> statement-breakpoint
GRANT UPDATE (slug, title) ON meetings TO changeset;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA om TO changeset;--> statement-breakpoint

CREATE TABLE om.changes (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  xact xid8 NOT NULL DEFAULT pg_current_xact_id(),
  tbl text NOT NULL,
  op text NOT NULL,
  row_id integer NOT NULL,
  -- The meetings the row belonged to before and after the change.
  meeting_ids integer[] NOT NULL
);--> statement-breakpoint

-- TG_ARGV[0]: the column holding the row's meeting, if it has one.
CREATE FUNCTION om.log_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  col text := TG_ARGV[0];
BEGIN
  INSERT INTO om.changes (tbl, op, row_id, meeting_ids)
  VALUES (TG_TABLE_NAME, TG_OP, (coalesce(n, o)->>'id')::integer,
    CASE WHEN col IS NULL THEN '{}'::integer[] ELSE ARRAY(
      SELECT DISTINCT x::integer FROM unnest(ARRAY[o->>col, n->>col]) x WHERE x IS NOT NULL
    ) END);
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE TRIGGER om_log_change AFTER INSERT OR UPDATE OR DELETE ON segments
  FOR EACH ROW WHEN (current_user = 'changeset') EXECUTE FUNCTION om.log_change('meeting_id');--> statement-breakpoint
CREATE TRIGGER om_log_change AFTER INSERT OR UPDATE OR DELETE ON chapters
  FOR EACH ROW WHEN (current_user = 'changeset') EXECUTE FUNCTION om.log_change('meeting_id');--> statement-breakpoint
CREATE TRIGGER om_log_change AFTER INSERT OR UPDATE OR DELETE ON meetings
  FOR EACH ROW WHEN (current_user = 'changeset') EXECUTE FUNCTION om.log_change('id');--> statement-breakpoint
CREATE TRIGGER om_log_change AFTER INSERT OR UPDATE OR DELETE ON people
  FOR EACH ROW WHEN (current_user = 'changeset') EXECUTE FUNCTION om.log_change();--> statement-breakpoint

CREATE FUNCTION om.run(changeset_sql text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  EXECUTE changeset_sql;
END $$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION om.run(text) FROM PUBLIC;--> statement-breakpoint
-- A new owner needs CREATE on the function's schema, but only while it
-- becomes the owner.
GRANT CREATE ON SCHEMA om TO changeset;--> statement-breakpoint
ALTER FUNCTION om.run(text) OWNER TO changeset;--> statement-breakpoint
REVOKE CREATE ON SCHEMA om FROM changeset;
