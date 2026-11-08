-- Hand-written: drizzle-kit doesn't manage functions. The `om` schema holds
-- the functions a changeset (packages/edit/README.md) calls: om.assert, and
-- edits to a meeting's transcript. An edit takes the meeting by slug or id,
-- addresses a word by its onset as "H:MM:SS.ss" (matched to the hundredth,
-- as `pnpm transcript render` and `words` print it), and a speaker by its
-- speaker label. After each edit, no segment is empty and no two neighbouring
-- segments have the same speaker.
CREATE SCHEMA om;--> statement-breakpoint

-- Raises SQLSTATE OM001 with `msg` unless `cond` is true, so a failed
-- assertion can be told from any other error.
CREATE FUNCTION om.assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'OM001',
      MESSAGE = coalesce(msg, 'assertion failed');
  END IF;
END $$;--> statement-breakpoint

-- The id of the meeting `meeting` names: an id if it is all digits, else a slug.
CREATE FUNCTION om.meeting_id(meeting text) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  found_id integer;
BEGIN
  IF meeting ~ '^[0-9]+$' THEN
    SELECT m.id INTO found_id FROM meetings m WHERE m.id = meeting::integer;
  ELSE
    SELECT m.id INTO found_id FROM meetings m WHERE m.slug = meeting;
  END IF;
  IF found_id IS NULL THEN
    RAISE EXCEPTION 'no meeting %', coalesce(to_json(meeting)::text, 'null');
  END IF;
  RETURN found_id;
END $$;--> statement-breakpoint

-- "H:MM:SS(.ss)", "MM:SS(.ss)" or "SS(.ss)" as seconds, as parseClock reads it.
CREATE FUNCTION om.onset(t text) RETURNS float8
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text[] := regexp_match(btrim(t), '^(?:(?:([0-9]+):)?([0-9]{1,2}):)?([0-9]+(?:\.[0-9]+)?)$');
BEGIN
  IF m IS NULL THEN
    RAISE EXCEPTION 'bad time % (want H:MM:SS.ss)', coalesce(to_json(t)::text, 'null');
  END IF;
  RETURN coalesce(m[1], '0')::float8 * 3600 + coalesce(m[2], '0')::float8 * 60 + m[3]::float8;
END $$;--> statement-breakpoint

-- Seconds as whole hundredths, the precision onsets are addressed at.
CREATE FUNCTION om.cs(secs float8) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT floor(secs * 100 + 0.5)::bigint $$;--> statement-breakpoint

-- Seconds as "H:MM:SS.ss", as formatClock writes them.
CREATE FUNCTION om.clock(secs float8) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('%s:%s:%s.%s', c / 360000, lpad((c / 6000 % 60)::text, 2, '0'),
    lpad((c / 100 % 60)::text, 2, '0'), lpad((c % 100)::text, 2, '0'))
  FROM (SELECT om.cs(secs) AS c) x
$$;--> statement-breakpoint

-- The person or speaker number a speaker label names: exactly one of them, or
-- neither for "unlabeled".
CREATE FUNCTION om.speaker(label text, OUT person_id integer, OUT speaker_number integer)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  m text[];
BEGIN
  IF label = 'unlabeled' THEN
    RETURN;
  END IF;
  m := regexp_match(label, '^segmented:spk-([0-9]+)$');
  IF m IS NOT NULL THEN
    speaker_number := m[1]::integer;
    RETURN;
  END IF;
  m := regexp_match(label, '^identified:([a-z0-9]+(?:-[a-z0-9]+)*)$');
  IF m IS NOT NULL THEN
    SELECT p.id INTO person_id FROM people p WHERE p.slug = m[1];
    IF person_id IS NULL THEN
      RAISE EXCEPTION 'no person with slug %: give an existing person that slug first, with UPDATE people SET slug = ...', to_json(m[1]);
    END IF;
    RETURN;
  END IF;
  m := regexp_match(label, '^person:([0-9]+)$');
  IF m IS NOT NULL THEN
    SELECT p.id INTO person_id FROM people p WHERE p.id = m[1]::integer;
    IF person_id IS NULL THEN
      RAISE EXCEPTION 'no person with id %', m[1];
    END IF;
    RETURN;
  END IF;
  RAISE EXCEPTION 'bad speaker label % (want unlabeled, segmented:spk-<n>, identified:<slug> or person:<id>)',
    coalesce(to_json(label)::text, 'null');
END $$;--> statement-breakpoint

-- Every word of a meeting, in transcript order (`n`), with its segment, its
-- 0-based index there, and the segment's speaker.
CREATE FUNCTION om.meeting_words(mid integer)
RETURNS TABLE (n bigint, segment_id integer, word_index integer, text text,
  start float8, person_id integer, speaker_number integer)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT row_number() OVER (ORDER BY s.start_secs, s.id, w.ordinality),
    s.id, (w.ordinality - 1)::integer, w.value->>'text',
    (w.value->>'start')::float8, s.person_id, s.speaker_number
  FROM segments s
  CROSS JOIN LATERAL jsonb_array_elements(s.words) WITH ORDINALITY AS w
  WHERE s.meeting_id = mid
$$;--> statement-breakpoint

-- The segment and 0-based word index of the meeting's word at onset `at`,
-- equal to `word` if given. Raises naming the words near `at` if none is.
CREATE FUNCTION om.find_word(mid integer, at text, word text,
  OUT segment_id integer, OUT word_index integer)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  secs float8 := om.onset(at);
  near text;
BEGIN
  SELECT w.segment_id, w.word_index INTO segment_id, word_index
  FROM om.meeting_words(mid) w
  WHERE om.cs(w.start) = om.cs(secs) AND (word IS NULL OR w.text = word)
  ORDER BY w.n LIMIT 1;
  IF FOUND THEN
    RETURN;
  END IF;
  SELECT string_agg(om.clock(x.start) || '=' || x.text, ' ' ORDER BY x.n) INTO near
  FROM (SELECT * FROM om.meeting_words(mid) w
        WHERE abs(w.start - secs) < 3 ORDER BY w.n LIMIT 12) x;
  RAISE EXCEPTION 'no word% at %; nearby: %',
    CASE WHEN word IS NULL THEN '' ELSE ' ' || to_json(word)::text END,
    om.clock(secs), coalesce(near, '(none)');
END $$;--> statement-breakpoint

-- Text split on whitespace.
CREATE FUNCTION om.split_words(t text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(w ORDER BY o), '{}')
  FROM regexp_split_to_table(coalesce(t, ''), '\s+') WITH ORDINALITY AS x(w, o)
  WHERE w <> ''
$$;--> statement-breakpoint

-- Words i to j - 1 (0-based) of a words array.
CREATE FUNCTION om.slice_words(words jsonb, i integer, j integer) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_agg(e.v ORDER BY e.o), '[]')
  FROM jsonb_array_elements(words) WITH ORDINALITY AS e(v, o)
  WHERE e.o > i AND e.o <= j
$$;--> statement-breakpoint

-- Replace `n` words at `i` (0-based) with `texts`. Each new word takes the
-- onset of the old word in its position, or the last old word's when there
-- are more.
CREATE FUNCTION om.splice_words(words jsonb, i integer, n integer, texts text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k integer;
  added jsonb := '[]';
BEGIN
  FOR k IN 1 .. coalesce(cardinality(texts), 0) LOOP
    added := added || jsonb_build_array(jsonb_build_object(
      'text', texts[k], 'start', words->(i + least(k - 1, n - 1))->'start'));
  END LOOP;
  RETURN om.slice_words(words, 0, i) || added
    || om.slice_words(words, i + n, jsonb_array_length(words));
END $$;--> statement-breakpoint

-- A word without its trailing punctuation, lowercased: how replace_all_words
-- compares words.
CREATE FUNCTION om.norm_word(w text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT lower(regexp_replace(w, '[.,?!;:"'']+$', '')) $$;--> statement-breakpoint

CREATE FUNCTION om.trailing_punct(w text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(substring(w FROM '[.,?!;:"'']+$'), '') $$;--> statement-breakpoint

-- Set a segment's words, deleting it if there are none.
CREATE FUNCTION om.set_words(segment_id integer, words jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF jsonb_array_length(words) = 0 THEN
    DELETE FROM segments s WHERE s.id = segment_id;
  ELSE
    UPDATE segments s SET words = set_words.words WHERE s.id = segment_id;
  END IF;
END $$;--> statement-breakpoint

-- Merge each of the meeting's segments into the one before it when they have
-- the same speaker. The earlier segment keeps its row.
CREATE FUNCTION om.merge_neighbours(mid integer) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  keep_id integer;
  keep_person integer;
  keep_number integer;
  keep_words jsonb;
  merged boolean := false;
BEGIN
  FOR r IN
    SELECT s.id, s.person_id, s.speaker_number, s.words FROM segments s
    WHERE s.meeting_id = mid ORDER BY s.start_secs, s.id
  LOOP
    IF keep_id IS NOT NULL AND r.person_id IS NOT DISTINCT FROM keep_person
        AND r.speaker_number IS NOT DISTINCT FROM keep_number THEN
      keep_words := keep_words || r.words;
      merged := true;
      DELETE FROM segments s WHERE s.id = r.id;
    ELSE
      IF merged THEN
        UPDATE segments s SET words = keep_words WHERE s.id = keep_id;
      END IF;
      keep_id := r.id;
      keep_person := r.person_id;
      keep_number := r.speaker_number;
      keep_words := r.words;
      merged := false;
    END IF;
  END LOOP;
  IF merged THEN
    UPDATE segments s SET words = keep_words WHERE s.id = keep_id;
  END IF;
END $$;--> statement-breakpoint

-- The word at `at` (and equal to `word`, unless null) starts a new segment
-- spoken by `speaker`, running to the end of its segment. If it already
-- starts a segment, that whole segment is relabelled.
CREATE FUNCTION om.split_segment(meeting text, at text, word text, speaker text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mid integer := om.meeting_id(meeting);
  f record;
  who record;
  seg record;
BEGIN
  SELECT * INTO f FROM om.find_word(mid, at, word);
  SELECT * INTO who FROM om.speaker(speaker);
  SELECT s.id, s.words INTO seg FROM segments s WHERE s.id = f.segment_id;
  IF f.word_index = 0 THEN
    UPDATE segments s SET person_id = who.person_id, speaker_number = who.speaker_number
    WHERE s.id = seg.id;
  ELSE
    UPDATE segments s SET words = om.slice_words(seg.words, 0, f.word_index)
    WHERE s.id = seg.id;
    INSERT INTO segments (meeting_id, person_id, speaker_number, words)
    VALUES (mid, who.person_id, who.speaker_number,
      om.slice_words(seg.words, f.word_index, jsonb_array_length(seg.words)));
  END IF;
  PERFORM om.merge_neighbours(mid);
END $$;--> statement-breakpoint

-- Relabel the whole segment holding the word at `at`.
CREATE FUNCTION om.relabel(meeting text, at text, speaker text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mid integer := om.meeting_id(meeting);
  f record;
  who record;
BEGIN
  SELECT * INTO f FROM om.find_word(mid, at, NULL);
  SELECT * INTO who FROM om.speaker(speaker);
  UPDATE segments s SET person_id = who.person_id, speaker_number = who.speaker_number
  WHERE s.id = f.segment_id;
  PERFORM om.merge_neighbours(mid);
END $$;--> statement-breakpoint

-- Replace the words starting at `at`, which must read `old` (space
-- separated), with `new`, which may have more or fewer words; '' deletes.
CREATE FUNCTION om.replace_words(meeting text, at text, old text, new text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mid integer := om.meeting_id(meeting);
  f record;
  olds text[] := om.split_words(old);
  words jsonb;
  got text;
BEGIN
  SELECT * INTO f FROM om.find_word(mid, at, NULL);
  IF cardinality(olds) = 0 THEN
    RAISE EXCEPTION 'replace_words needs the words it replaces';
  END IF;
  SELECT s.words INTO words FROM segments s WHERE s.id = f.segment_id;
  SELECT coalesce(string_agg(e.v->>'text', ' ' ORDER BY e.o), '') INTO got
  FROM jsonb_array_elements(om.slice_words(words, f.word_index, f.word_index + cardinality(olds)))
    WITH ORDINALITY AS e(v, o);
  IF got <> array_to_string(olds, ' ') THEN
    RAISE EXCEPTION 'expected % at %, found %', to_json(array_to_string(olds, ' ')),
      om.clock(om.onset(at)), to_json(got);
  END IF;
  PERFORM om.set_words(f.segment_id,
    om.splice_words(words, f.word_index, cardinality(olds), om.split_words(new)));
  PERFORM om.merge_neighbours(mid);
END $$;--> statement-breakpoint

-- Add words the transcript is missing, each 'H:MM:SS.ss word'. With
-- `speaker`, they are their own segment and the words after them go back to
-- whoever was speaking; without, they join the segment of the word before
-- them (or the first segment).
CREATE FUNCTION om.insert_words(meeting text, words text[], speaker text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mid integer := om.meeting_id(meeting);
  who record;
  item text;
  m text[];
  secs float8;
  word text;
  new_word jsonb;
  prev record;
  seg record;
BEGIN
  SELECT * INTO who FROM om.speaker(coalesce(speaker, 'unlabeled'));
  FOREACH item IN ARRAY coalesce(words, '{}') LOOP
    m := regexp_match(item, '^\s*(\S+)\s+(.*)$');
    IF m IS NULL THEN
      RAISE EXCEPTION 'bad word % (want ''H:MM:SS.ss word'')', to_json(item);
    END IF;
    secs := om.onset(m[1]);
    word := regexp_replace(m[2], '^\s+|\s+$', '', 'g');
    IF word = '' OR word ~ '\s' THEN
      RAISE EXCEPTION 'can''t insert %: not one word', to_json(m[2]);
    END IF;
    IF EXISTS (SELECT 1 FROM om.meeting_words(mid) w WHERE om.cs(w.start) = om.cs(secs)) THEN
      RAISE EXCEPTION 'can''t insert %: a word already starts at %', to_json(word), om.clock(secs);
    END IF;
    new_word := jsonb_build_array(jsonb_build_object('text', word, 'start', secs));

    SELECT * INTO prev FROM om.meeting_words(mid) w WHERE w.start < secs ORDER BY w.n DESC LIMIT 1;
    IF NOT FOUND THEN
      -- Before every word: the start of the first segment, or its own segment.
      SELECT s.id, s.words, s.person_id, s.speaker_number INTO seg FROM segments s
      WHERE s.meeting_id = mid ORDER BY s.start_secs, s.id LIMIT 1;
      IF FOUND AND (speaker IS NULL OR (seg.person_id IS NOT DISTINCT FROM who.person_id
          AND seg.speaker_number IS NOT DISTINCT FROM who.speaker_number)) THEN
        UPDATE segments s SET words = new_word || seg.words WHERE s.id = seg.id;
      ELSE
        INSERT INTO segments (meeting_id, person_id, speaker_number, words)
        VALUES (mid, who.person_id, who.speaker_number, new_word);
      END IF;
      CONTINUE;
    END IF;

    SELECT s.id, s.words INTO seg FROM segments s WHERE s.id = prev.segment_id;
    IF speaker IS NULL OR (prev.person_id IS NOT DISTINCT FROM who.person_id
        AND prev.speaker_number IS NOT DISTINCT FROM who.speaker_number) THEN
      UPDATE segments s SET words = om.slice_words(seg.words, 0, prev.word_index + 1)
        || new_word || om.slice_words(seg.words, prev.word_index + 1, jsonb_array_length(seg.words))
      WHERE s.id = seg.id;
    ELSE
      UPDATE segments s SET words = om.slice_words(seg.words, 0, prev.word_index + 1)
      WHERE s.id = seg.id;
      INSERT INTO segments (meeting_id, person_id, speaker_number, words)
      VALUES (mid, who.person_id, who.speaker_number, new_word);
      IF prev.word_index + 1 < jsonb_array_length(seg.words) THEN
        INSERT INTO segments (meeting_id, person_id, speaker_number, words)
        VALUES (mid, prev.person_id, prev.speaker_number,
          om.slice_words(seg.words, prev.word_index + 1, jsonb_array_length(seg.words)));
      END IF;
    END IF;
  END LOOP;
  PERFORM om.merge_neighbours(mid);
END $$;--> statement-breakpoint

-- Replace every occurrence of `old` in the meeting, ignoring case and
-- trailing punctuation, keeping the last old word's trailing punctuation.
-- Returns how many it replaced.
CREATE FUNCTION om.replace_all_words(meeting text, old text, new text) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mid integer := om.meeting_id(meeting);
  olds text[] := ARRAY(SELECT om.norm_word(w) FROM unnest(om.split_words(old)) WITH ORDINALITY AS x(w, o) ORDER BY o);
  repl text[] := om.split_words(new);
  n integer := cardinality(olds);
  seg record;
  words jsonb;
  normed text[];
  texts text[];
  k integer;
  replaced integer := 0;
BEGIN
  IF n = 0 THEN
    RAISE EXCEPTION 'replace_all_words needs words to replace';
  END IF;
  FOR seg IN
    SELECT s.id, s.words FROM segments s
    WHERE s.meeting_id = mid AND strpos(lower(s.text), olds[1]) > 0
    ORDER BY s.start_secs, s.id
  LOOP
    words := seg.words;
    normed := ARRAY(SELECT om.norm_word(e.v->>'text') FROM jsonb_array_elements(words) WITH ORDINALITY AS e(v, o) ORDER BY e.o);
    k := 0;
    WHILE k <= cardinality(normed) - n LOOP
      IF normed[k + 1 : k + n] = olds THEN
        texts := repl;
        IF cardinality(texts) > 0 AND om.trailing_punct(texts[cardinality(texts)]) = '' THEN
          texts[cardinality(texts)] := texts[cardinality(texts)] || om.trailing_punct(words->(k + n - 1)->>'text');
        END IF;
        words := om.splice_words(words, k, n, texts);
        normed := normed[1 : k] || ARRAY(SELECT om.norm_word(t) FROM unnest(texts) WITH ORDINALITY AS x(t, o) ORDER BY o)
          || normed[k + n + 1 : cardinality(normed)];
        replaced := replaced + 1;
        k := k + cardinality(texts);
      ELSE
        k := k + 1;
      END IF;
    END LOOP;
    IF words <> seg.words THEN
      PERFORM om.set_words(seg.id, words);
    END IF;
  END LOOP;
  PERFORM om.merge_neighbours(mid);
  RETURN replaced;
END $$;
