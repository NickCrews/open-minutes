-- Hand-added: drizzle-kit doesn't manage functions. The onset of the first word
-- and the offset of the last, as intervals. IMMUTABLE so they can back the
-- generated columns below. Null on an empty array — the CHECK at the bottom
-- rules that case out.
CREATE FUNCTION words_start_secs(words jsonb) RETURNS interval
LANGUAGE sql IMMUTABLE AS $$
  SELECT make_interval(secs => (words->0->>'start')::float8)
$$;--> statement-breakpoint
CREATE FUNCTION words_end_secs(words jsonb) RETURNS interval
LANGUAGE sql IMMUTABLE AS $$
  SELECT make_interval(secs => (words->-1->>'end')::float8)
$$;--> statement-breakpoint
-- duration_secs drops first: it currently reads start_secs/end_secs, and
-- Postgres won't drop a column a generated column depends on.
ALTER TABLE "segments" DROP COLUMN "duration_secs";--> statement-breakpoint
ALTER TABLE "segments" DROP COLUMN "start_secs";--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "start_secs" interval second(3) GENERATED ALWAYS AS (words_start_secs("segments"."words")) STORED;--> statement-breakpoint
ALTER TABLE "segments" DROP COLUMN "end_secs";--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "end_secs" interval second(3) GENERATED ALWAYS AS (words_end_secs("segments"."words")) STORED;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "duration_secs" interval second(3) GENERATED ALWAYS AS (words_end_secs("segments"."words") - words_start_secs("segments"."words")) STORED;--> statement-breakpoint
DELETE FROM "segments" WHERE jsonb_array_length("words") = 0;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_words_nonempty" CHECK (jsonb_array_length("words") > 0);
