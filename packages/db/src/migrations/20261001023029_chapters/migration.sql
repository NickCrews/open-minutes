-- Chapters: a meeting's table of contents, and the runs that wrote them. See
-- docs/chapters.md.
--
-- Hand-edited: the exclusion constraint at the end is added by hand, because
-- drizzle-kit doesn't manage exclusion constraints. It keeps a meeting's
-- chapters from overlapping; btree_gist lets `meeting_id WITH =` sit in the
-- same GiST index as the time range.

CREATE TABLE "chapter_generations" (
	"id" serial PRIMARY KEY,
	"meeting_id" integer NOT NULL,
	"model" varchar NOT NULL,
	"prompt_version" varchar NOT NULL,
	"transcript_fingerprint" varchar NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_by_human" boolean DEFAULT false NOT NULL,
	CONSTRAINT "chapter_generations_id_meeting_id_unique" UNIQUE("id","meeting_id")
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" serial PRIMARY KEY,
	"meeting_id" integer NOT NULL,
	"generation_id" integer NOT NULL,
	"start_secs" interval second(3) NOT NULL,
	"end_secs" interval second(3) NOT NULL,
	"title" varchar NOT NULL,
	"summary" varchar NOT NULL,
	"bullets" varchar[] DEFAULT '{}'::varchar[] NOT NULL,
	CONSTRAINT "chapters_end_after_start" CHECK ("end_secs" > "start_secs"),
	CONSTRAINT "chapters_start_nonnegative" CHECK ("start_secs" >= '0')
);
--> statement-breakpoint
CREATE INDEX "idx_chapters_meeting_start" ON "chapters" ("meeting_id","start_secs");--> statement-breakpoint
ALTER TABLE "chapter_generations" ADD CONSTRAINT "chapter_generations_meeting_id_meetings_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id");--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_generation_fkey" FOREIGN KEY ("generation_id","meeting_id") REFERENCES "chapter_generations"("id","meeting_id");--> statement-breakpoint
CREATE VIEW "chapter_speakers" AS (SELECT c.id AS chapter_id, c.meeting_id, s.person_id,
        CASE WHEN s.person_id IS NULL THEN s.speaker_number END AS speaker_number,
        sum(LEAST(s.end_secs, c.end_secs) - GREATEST(s.start_secs, c.start_secs)) AS speaking_secs
      FROM chapters c
      JOIN segments s ON s.meeting_id = c.meeting_id
        AND s.start_secs < c.end_secs AND s.end_secs > c.start_secs
      GROUP BY c.id, c.meeting_id, s.person_id,
        CASE WHEN s.person_id IS NULL THEN s.speaker_number END);
--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_title_nonblank" CHECK (btrim("title") <> '');--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_summary_nonblank" CHECK (btrim("summary") <> '');--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_bullets_nonblank" CHECK ('' <> ALL ("bullets"));--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_no_overlap" EXCLUDE USING gist (
	"meeting_id" WITH =,
	numrange(extract(epoch FROM "start_secs"), extract(epoch FROM "end_secs")) WITH &&
);
