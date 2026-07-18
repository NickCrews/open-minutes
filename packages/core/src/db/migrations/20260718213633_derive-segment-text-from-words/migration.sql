-- Hand-added: drizzle-kit doesn't manage functions. Joins the `text` of each
-- word in a words jsonb array with spaces, in array order. IMMUTABLE so it can
-- back the generated `segments.text` column below.
CREATE FUNCTION words_to_text(words jsonb) RETURNS varchar
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(w.value->>'text', ' ' ORDER BY w.ordinality)
  FROM jsonb_array_elements(words) WITH ORDINALITY AS w
$$;--> statement-breakpoint
ALTER TABLE "segments" DROP COLUMN "text";--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "text" varchar GENERATED ALWAYS AS (words_to_text("segments"."words")) STORED;--> statement-breakpoint
ALTER TABLE "segments" ALTER COLUMN "words" SET NOT NULL;
