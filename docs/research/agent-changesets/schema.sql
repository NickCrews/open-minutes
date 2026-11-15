-- A cut-down copy of the tables agents edit, with the same kinds of keys,
-- foreign keys, generated columns and defaults as packages/db/src/schema.ts.

CREATE FUNCTION words_to_text(words jsonb) RETURNS varchar
  LANGUAGE sql IMMUTABLE AS
  $$ SELECT string_agg(w->>'w', ' ' ORDER BY ord) FROM jsonb_array_elements(words) WITH ORDINALITY AS t(w, ord) $$;

CREATE TABLE meetings (
  id serial PRIMARY KEY,
  slug varchar UNIQUE,
  title varchar NOT NULL
);

CREATE TABLE people (
  id serial PRIMARY KEY,
  slug varchar UNIQUE,
  name varchar,
  bio varchar,
  created_at timestamp NOT NULL DEFAULT now(),
  voice_embedding real[] NOT NULL DEFAULT '{0,0,0}'
);

-- Stands in for any table that cascades from another.
CREATE TABLE people_notes (
  id serial PRIMARY KEY,
  person_id integer NOT NULL REFERENCES people ON DELETE CASCADE,
  note varchar NOT NULL
);

CREATE TABLE segments (
  id serial PRIMARY KEY,
  meeting_id integer NOT NULL REFERENCES meetings,
  person_id integer REFERENCES people,
  speaker_number integer,
  text varchar GENERATED ALWAYS AS (words_to_text(words)) STORED,
  words jsonb NOT NULL CHECK (jsonb_array_length(words) > 0),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE chapter_generations (
  id serial PRIMARY KEY,
  meeting_id integer NOT NULL REFERENCES meetings,
  model varchar NOT NULL,
  generated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (id, meeting_id)
);

CREATE TABLE chapters (
  id serial PRIMARY KEY,
  meeting_id integer NOT NULL,
  generation_id integer NOT NULL,
  start_secs numeric NOT NULL,
  end_secs numeric NOT NULL,
  title varchar NOT NULL,
  FOREIGN KEY (generation_id, meeting_id) REFERENCES chapter_generations (id, meeting_id),
  CHECK (end_secs > start_secs)
);

-- ---------------------------------------------------------------- harness

CREATE SCHEMA om;

CREATE TABLE om.changesets (
  id text PRIMARY KEY,
  applied_at timestamp NOT NULL DEFAULT now()
);

-- Every row change a changeset makes, in order. Written only inside checks
-- and applies, which run as the changeset role.
CREATE TABLE om.capture_log (
  seq bigserial PRIMARY KEY,
  tbl text NOT NULL,
  op text NOT NULL,
  old jsonb,
  new jsonb
);

CREATE FUNCTION om.capture() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Gate on session_user, which SQL run by that session can't change.
  IF session_user <> 'changeset' THEN RETURN NULL; END IF;
  INSERT INTO om.capture_log (tbl, op, old, new) VALUES (
    TG_TABLE_NAME, TG_OP,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meetings','people','people_notes','segments','chapter_generations','chapters'] LOOP
    EXECUTE format('CREATE TRIGGER om_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION om.capture()', t);
  END LOOP;
END $$;

-- Runs a changeset's SQL. Inside a function, COMMIT and ROLLBACK raise
-- instead of ending the harness's transaction.
CREATE FUNCTION om.run(sql text) RETURNS void
  LANGUAGE plpgsql AS $$ BEGIN EXECUTE sql; END $$;

CREATE FUNCTION om.assert(ok boolean, message text) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION '%', message USING ERRCODE = 'OM001'; END IF;
END $$;

-- The changeset role reads everything and writes data columns only: no ids,
-- no generated columns, no timestamps filled by defaults.
GRANT USAGE ON SCHEMA om TO changeset;
GRANT EXECUTE ON FUNCTION om.run(text), om.assert(boolean, text) TO changeset;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO changeset;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO changeset;
GRANT SELECT ON om.capture_log TO changeset;
GRANT INSERT (slug, name, bio, voice_embedding), UPDATE (slug, name, bio, voice_embedding), DELETE ON people TO changeset;
GRANT INSERT (person_id, note), UPDATE (note), DELETE ON people_notes TO changeset;
GRANT INSERT (meeting_id, person_id, speaker_number, words), UPDATE (person_id, speaker_number, words), DELETE ON segments TO changeset;
GRANT INSERT (meeting_id, model), DELETE ON chapter_generations TO changeset;
GRANT INSERT (meeting_id, generation_id, start_secs, end_secs, title), UPDATE (start_secs, end_secs, title), DELETE ON chapters TO changeset;

-- ---------------------------------------------------------------- base data

INSERT INTO meetings (slug, title) VALUES ('m1', 'Assembly 2026-03-23'), ('m2', 'School board 2026-03-24');
INSERT INTO people (slug, name) VALUES ('alice-adams', 'Alice Adams');
INSERT INTO people (slug, name) VALUES (NULL, NULL), (NULL, NULL);  -- anonymous voices 2 and 3
INSERT INTO people_notes (person_id, note) VALUES (3, 'sounds like the clerk');
INSERT INTO segments (meeting_id, person_id, speaker_number, words) VALUES
  (1, 1, 1, '[{"w":"Call","s":0},{"w":"to","s":0.4},{"w":"order.","s":0.6}]'),
  (1, 2, 2, '[{"w":"Roll","s":2},{"w":"call.","s":2.4}]'),
  (1, NULL, 3, '[{"w":"Here.","s":4}]'),
  (1, 3, 4, '[{"w":"Item","s":6},{"w":"one.","s":6.3},{"w":"Second","s":7},{"w":"by","s":7.4},{"w":"Jones.","s":7.6}]'),
  (1, NULL, 3, '[{"w":"Present.","s":9}]'),
  (2, 3, 1, '[{"w":"Welcome.","s":0}]');
INSERT INTO chapter_generations (meeting_id, model) VALUES (1, 'model-a');
INSERT INTO chapters (meeting_id, generation_id, start_secs, end_secs, title) VALUES
  (1, 1, 0, 5, 'Opening'), (1, 1, 5, 10, 'Item one');

-- Records that a changeset was applied, in the applying transaction, so a
-- second apply fails on the key.
CREATE FUNCTION om.claim(changeset_id text) RETURNS void
  LANGUAGE sql SECURITY DEFINER AS $$ INSERT INTO om.changesets (id) VALUES (changeset_id) $$;
GRANT EXECUTE ON FUNCTION om.claim(text) TO changeset;

CREATE FUNCTION om.clear_log() RETURNS void
  LANGUAGE sql SECURITY DEFINER AS $$ DELETE FROM om.capture_log $$;
GRANT EXECUTE ON FUNCTION om.clear_log() TO changeset;
