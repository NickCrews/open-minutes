-- recordings: what scouting finds on the sites that publish recordings, before
-- any meeting exists. recording_bodies: the bodies whose meeting source lists
-- each one. meetings.recording_id replaces meetings.site_kind, site_id and url.
-- See schema.ts and docs/contributing/recordings.md.
--
-- Hand-edited: each existing meeting gets a recording, from its site_kind,
-- site_id, url, title, description and created_at. Its duration is the
-- meeting's, else the end of its last segment, else 0. audio_stored_at is
-- left null, so the next scouting run stores its audio (from the blob store,
-- for most). The meeting's bodies become its recording's, and recording_id
-- is set before it becomes NOT NULL and the old columns go.

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
	"permalink" varchar NOT NULL,
	"title" varchar DEFAULT '' NOT NULL,
	"description" varchar DEFAULT '' NOT NULL,
	"published_at" timestamp,
	"duration_secs" interval second(3) NOT NULL,
	"found_at" timestamp DEFAULT now() NOT NULL,
	"is_meeting" boolean,
	"notes" varchar DEFAULT '' NOT NULL,
	"audio_stored_at" timestamp,
	"audio_error_history" varchar[] DEFAULT '{}'::varchar[] NOT NULL,
	CONSTRAINT "recordings_site_external_id_unique" UNIQUE("site","external_id"),
	CONSTRAINT "recordings_site_known" CHECK ("site" IN ('youtube', 'akleg'))
);
--> statement-breakpoint
ALTER TABLE "recording_bodies" ADD CONSTRAINT "recording_bodies_recording_id_recordings_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recording_bodies" ADD CONSTRAINT "recording_bodies_body_id_bodies_id_fkey" FOREIGN KEY ("body_id") REFERENCES "bodies"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "recordings" ("site", "external_id", "permalink", "title", "description", "duration_secs", "found_at", "is_meeting", "notes")
SELECT m."site_kind", m."site_id", m."url", m."title", m."description",
	coalesce(m."duration_secs", (SELECT max(s."end_secs") FROM "segments" s WHERE s."meeting_id" = m."id"), interval '0'),
	m."created_at", true, ''
FROM "meetings" m
ORDER BY m."id";--> statement-breakpoint
INSERT INTO "recording_bodies" ("recording_id", "body_id")
SELECT r."id", mb."body_id"
FROM "meeting_bodies" mb
JOIN "meetings" m ON m."id" = mb."meeting_id"
JOIN "recordings" r ON r."site" = m."site_kind" AND r."external_id" = m."site_id";--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "recording_id" integer;--> statement-breakpoint
UPDATE "meetings" m SET "recording_id" = r."id"
FROM "recordings" r
WHERE r."site" = m."site_kind" AND r."external_id" = m."site_id";--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "recording_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_recording_id_key" UNIQUE("recording_id");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_recording_id_recordings_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id");--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_site_kind_site_id_unique";--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_site_kind_known";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "site_kind";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "site_id";
