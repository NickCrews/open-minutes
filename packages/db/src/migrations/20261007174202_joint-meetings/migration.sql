CREATE TABLE "meeting_bodies" (
	"meeting_id" integer,
	"body_id" integer,
	CONSTRAINT "meeting_bodies_pkey" PRIMARY KEY("meeting_id","body_id")
);
--> statement-breakpoint
-- Each meeting's one body becomes its one row in meeting_bodies, and lends it
-- its timezone, the zone its date and time were read in. Body timezones
-- already pass iana_timezone_error(), so the copies pass the check below.
INSERT INTO "meeting_bodies" ("meeting_id", "body_id") SELECT "id", "body_id" FROM "meetings";--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "timezone" varchar;--> statement-breakpoint
UPDATE "meetings" m SET "timezone" = b."timezone" FROM "bodies" b WHERE b."id" = m."body_id";--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "timezone" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_timezone_valid" CHECK (iana_timezone_error("timezone") IS NULL);--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_body_id_bodies_id_fkey";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "body_id";--> statement-breakpoint
CREATE INDEX "idx_meeting_bodies_body" ON "meeting_bodies" ("body_id");--> statement-breakpoint
ALTER TABLE "meeting_bodies" ADD CONSTRAINT "meeting_bodies_meeting_id_meetings_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "meeting_bodies" ADD CONSTRAINT "meeting_bodies_body_id_bodies_id_fkey" FOREIGN KEY ("body_id") REFERENCES "bodies"("id");
