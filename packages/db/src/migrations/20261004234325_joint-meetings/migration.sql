CREATE TABLE "meeting_cohosts" (
	"meeting_id" integer,
	"body_id" integer,
	CONSTRAINT "meeting_cohosts_pkey" PRIMARY KEY("meeting_id","body_id")
);
--> statement-breakpoint
CREATE INDEX "idx_meeting_cohosts_body" ON "meeting_cohosts" ("body_id");--> statement-breakpoint
ALTER TABLE "meeting_cohosts" ADD CONSTRAINT "meeting_cohosts_meeting_id_meetings_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "meeting_cohosts" ADD CONSTRAINT "meeting_cohosts_body_id_bodies_id_fkey" FOREIGN KEY ("body_id") REFERENCES "bodies"("id");