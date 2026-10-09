ALTER TABLE "meetings" ADD COLUMN "transcribed_at" timestamp;--> statement-breakpoint
-- Until now a meeting row was written together with its transcript, so every
-- existing meeting was transcribed when it was created.
UPDATE "meetings" SET "transcribed_at" = "created_at";
