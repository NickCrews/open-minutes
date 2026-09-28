-- Words no longer store an `end` timestamp — only the onset is real data (the
-- recognizer reports no durations; the old `end` was an estimate). A segment's
-- end is now approximated as its last word's onset plus a nominal last-word
-- duration. The 0.5 here mirrors LAST_WORD_DURATION_SEC in
-- packages/core/src/transcription/types.ts — keep the two in sync.
CREATE OR REPLACE FUNCTION words_end_secs(words jsonb) RETURNS interval
LANGUAGE sql IMMUTABLE AS $$
  SELECT make_interval(secs => (words->-1->>'start')::float8 + 0.5)
$$;--> statement-breakpoint
-- Strip the stale `end` keys from existing rows. The rewrite also makes the
-- generated columns (text, start_secs, end_secs, duration_secs) recompute
-- against the redefined function.
UPDATE "segments" SET "words" = (
  SELECT jsonb_agg(word - 'end' ORDER BY idx)
  FROM jsonb_array_elements("words") WITH ORDINALITY AS w(word, idx)
);
