-- Hand-written, but for the DROP COLUMN. More for the `changeset` role
-- (packages/edit/README.md) to write: chapters and their generations,
-- meetings' date and time, the bodies holding a meeting, and deleting people.

ALTER TABLE "chapter_generations" DROP COLUMN "transcript_fingerprint";--> statement-breakpoint

GRANT INSERT (meeting_id, generation_id, start_secs, end_secs, title, summary, bullets),
  UPDATE (generation_id, start_secs, end_secs, title, summary, bullets), DELETE
  ON chapters TO changeset;--> statement-breakpoint
GRANT USAGE ON SEQUENCE chapters_id_seq TO changeset;--> statement-breakpoint
-- Not reviewed_by_human, which stays false: a person marks a generation
-- reviewed.
GRANT INSERT (meeting_id, model, prompt_version)
  ON chapter_generations TO changeset;--> statement-breakpoint
GRANT USAGE ON SEQUENCE chapter_generations_id_seq TO changeset;--> statement-breakpoint
GRANT UPDATE (date, time) ON meetings TO changeset;--> statement-breakpoint
GRANT INSERT (meeting_id, body_id), DELETE ON meeting_bodies TO changeset;--> statement-breakpoint
-- To merge two people. A person anyone's segments still name can't be
-- deleted: segments.person_id's foreign key refuses it.
GRANT DELETE ON people TO changeset;--> statement-breakpoint

-- A changed row is named by its primary key, as a JSON object of its columns
-- ({"id": 12}, or {"meeting_id": 3, "body_id": 1} for meeting_bodies), since
-- not every table has an `id`. The log is empty outside a changeset's
-- transaction.
TRUNCATE om.changes;--> statement-breakpoint
ALTER TABLE om.changes DROP COLUMN row_id;--> statement-breakpoint
ALTER TABLE om.changes ADD COLUMN row_key jsonb NOT NULL;--> statement-breakpoint

-- TG_ARGV[0]: the column holding the row's meeting, if it has one.
CREATE OR REPLACE FUNCTION om.log_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  col text := TG_ARGV[0];
  key jsonb;
BEGIN
  SELECT jsonb_object_agg(a.attname, coalesce(n, o)->a.attname) INTO key
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
  WHERE i.indrelid = TG_RELID AND i.indisprimary;
  INSERT INTO om.changes (tbl, op, row_key, meeting_ids)
  VALUES (TG_TABLE_NAME, TG_OP, key,
    CASE WHEN col IS NULL THEN '{}'::integer[] ELSE ARRAY(
      SELECT DISTINCT x::integer FROM unnest(ARRAY[o->>col, n->>col]) x WHERE x IS NOT NULL
    ) END);
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE TRIGGER om_log_change AFTER INSERT OR UPDATE OR DELETE ON chapter_generations
  FOR EACH ROW WHEN (current_user = 'changeset') EXECUTE FUNCTION om.log_change('meeting_id');--> statement-breakpoint
CREATE TRIGGER om_log_change AFTER INSERT OR UPDATE OR DELETE ON meeting_bodies
  FOR EACH ROW WHEN (current_user = 'changeset') EXECUTE FUNCTION om.log_change('meeting_id');
