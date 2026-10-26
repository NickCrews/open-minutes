-- recordings: one row per item found on a site, before and independent of
-- any meeting; meetings.recording_id replaces meetings.site_kind, site_id and
-- url. See docs/contributing/recordings.md.
--
-- Hand-edited: each existing meeting gets a recording, with its site, ID on
-- its site, page, title, description and duration, is_meeting true and its
-- bodies, before recording_id becomes NOT NULL and the old columns go. Their
-- audio_stored_at stays null: their audio is not yet at recordings/<site>/.

CREATE TABLE "recording_bodies" (
	"recording_id" integer,
	"body_id" integer,
	CONSTRAINT "recording_bodies_pkey" PRIMARY KEY("recording_id","body_id")
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" serial PRIMARY KEY,
	"site" varchar NOT NULL,
	"external_id" varchar NOT NULL,
	"permalink" varchar,
	"title" varchar DEFAULT '' NOT NULL,
	"description" varchar DEFAULT '' NOT NULL,
	"published_at" timestamp,
	"duration_secs" interval second(3),
	"scout_id" varchar,
	"found_at" timestamp DEFAULT now() NOT NULL,
	"is_meeting" boolean,
	"notes" varchar DEFAULT '' NOT NULL,
	"audio_stored_at" timestamp,
	"audio_failures" integer DEFAULT 0 NOT NULL,
	"audio_error" varchar,
	CONSTRAINT "recordings_site_external_id_unique" UNIQUE("site","external_id"),
	CONSTRAINT "recordings_site_known" CHECK ("site" IN ('youtube', 'akleg'))
);
--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_site_kind_site_id_unique";--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_site_kind_known";--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "recording_id" integer;--> statement-breakpoint
INSERT INTO "recordings" ("site", "external_id", "permalink", "title", "description", "duration_secs", "found_at", "is_meeting")
SELECT "site_kind", "site_id", "url", "title", "description", "duration_secs", "created_at", true
FROM "meetings" ORDER BY "id";--> statement-breakpoint
UPDATE "meetings" SET "recording_id" = "recordings"."id"
FROM "recordings"
WHERE "recordings"."site" = "meetings"."site_kind" AND "recordings"."external_id" = "meetings"."site_id";--> statement-breakpoint
INSERT INTO "recording_bodies" ("recording_id", "body_id")
SELECT "meetings"."recording_id", "meeting_bodies"."body_id"
FROM "meeting_bodies" JOIN "meetings" ON "meetings"."id" = "meeting_bodies"."meeting_id";--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "recording_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "site_kind";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "site_id";--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_recording_id_key" UNIQUE("recording_id");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_recording_id_recordings_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id");--> statement-breakpoint
ALTER TABLE "recording_bodies" ADD CONSTRAINT "recording_bodies_recording_id_recordings_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recording_bodies" ADD CONSTRAINT "recording_bodies_body_id_bodies_id_fkey" FOREIGN KEY ("body_id") REFERENCES "bodies"("id") ON DELETE CASCADE;