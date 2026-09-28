CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TYPE "meeting_status" AS ENUM(
	'discovered',
	'downloaded',
	'transcribed',
	'diarized',
	'aligned',
	'identified',
	'embedded'
);

--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" serial PRIMARY KEY,
	"municipality_id" integer NOT NULL,
	"youtube_id" varchar DEFAULT '' NOT NULL UNIQUE,
	"youtube_url" varchar GENERATED ALWAYS AS (
		CASE
			WHEN "meetings"."youtube_id" != '' THEN 'https://www.youtube.com/watch?v=' || "meetings"."youtube_id"
			ELSE ''
		END
	) STORED,
	"title" varchar DEFAULT '' NOT NULL,
	"description" varchar DEFAULT '' NOT NULL,
	"start_time" timestamp,
	"duration_secs" INTERVAL SECOND(3),
	"status" "meeting_status" DEFAULT 'discovered' :: "meeting_status" NOT NULL,
	"transcription" jsonb,
	"diarization" jsonb,
	"created_at" timestamp DEFAULT NOW() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "municipalities" (
	"id" serial PRIMARY KEY,
	"name" varchar DEFAULT '' NOT NULL,
	"name_short" varchar DEFAULT '' NOT NULL,
	"state" varchar DEFAULT '' NOT NULL,
	"postcode" varchar DEFAULT '',
	"youtube_channel_id" varchar DEFAULT '',
	"youtube_channel_url" varchar GENERATED ALWAYS AS (
		CASE
			WHEN "municipalities"."youtube_channel_id" != '' THEN 'https://www.youtube.com/channel/' || "municipalities"."youtube_channel_id"
			ELSE ''
		END
	) STORED,
	"created_at" timestamp DEFAULT NOW() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "people" (
	"id" serial PRIMARY KEY,
	"name" varchar DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT NOW() NOT NULL,
	"voice_embedding" vector(192) NOT NULL
);

--> statement-breakpoint
CREATE TABLE "segments" (
	"id" serial PRIMARY KEY,
	"meeting_id" integer NOT NULL,
	"person_id" integer,
	"text" varchar NOT NULL,
	"start_secs" INTERVAL SECOND(3),
	"end_secs" INTERVAL SECOND(3),
	"duration_secs" INTERVAL SECOND(3) GENERATED ALWAYS AS ("segments"."end_secs" - "segments"."start_secs") STORED,
	"words" jsonb,
	"text_embedding" vector(384),
	"created_at" timestamp DEFAULT NOW() NOT NULL
);

--> statement-breakpoint
CREATE INDEX "idx_voice_embedding_l2" ON "people" USING hnsw ("voice_embedding" vector_l2_ops);

--> statement-breakpoint
ALTER TABLE
	"meetings"
ADD
	CONSTRAINT "meetings_municipality_id_municipalities_id_fkey" FOREIGN KEY ("municipality_id") REFERENCES "municipalities"("id");

--> statement-breakpoint
ALTER TABLE
	"segments"
ADD
	CONSTRAINT "segments_meeting_id_meetings_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id");

--> statement-breakpoint
ALTER TABLE
	"segments"
ADD
	CONSTRAINT "segments_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id");