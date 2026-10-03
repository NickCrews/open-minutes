-- Processing runs: the audit trail of how each meeting was processed, so a
-- meeting can exist before it is transcribed. See ADR 0005.
--
-- Hand-edited: the backfill at the end is added by hand. Before this
-- migration a meeting row existed only once its transcript had been ingested,
-- so every meeting with segments gets one succeeded transcript run, at version
-- "untracked" (whatever the pipeline was at the time), dated when the meeting
-- was ingested.

CREATE TABLE "processing_runs" (
	"id" serial PRIMARY KEY,
	"meeting_id" integer NOT NULL,
	"step" varchar NOT NULL,
	"version" varchar NOT NULL,
	"status" varchar DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"error" varchar,
	"run_url" varchar,
	"details" jsonb DEFAULT '{}' NOT NULL,
	CONSTRAINT "processing_runs_step" CHECK ("step" IN ('transcript', 'chapters', 'summary')),
	CONSTRAINT "processing_runs_status" CHECK ("status" IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "processing_runs_finished_iff_done" CHECK (("status" = 'running') = ("finished_at" IS NULL)),
	CONSTRAINT "processing_runs_error_iff_failed" CHECK (("status" = 'failed') = ("error" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "idx_processing_runs_meeting_step" ON "processing_runs" ("meeting_id","step","started_at");--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_meeting_id_meetings_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id");--> statement-breakpoint
CREATE VIEW "meeting_processing" AS (SELECT DISTINCT ON (meeting_id, step)
        meeting_id, step, id AS run_id, version, finished_at AS succeeded_at
      FROM processing_runs
      WHERE status = 'succeeded'
      ORDER BY meeting_id, step, finished_at DESC, id DESC);--> statement-breakpoint
INSERT INTO "processing_runs" ("meeting_id", "step", "version", "status", "started_at", "finished_at")
SELECT m."id", 'transcript', 'untracked', 'succeeded', m."created_at", m."created_at"
FROM "meetings" m
WHERE EXISTS (SELECT 1 FROM "segments" s WHERE s."meeting_id" = m."id")
ORDER BY m."id";
