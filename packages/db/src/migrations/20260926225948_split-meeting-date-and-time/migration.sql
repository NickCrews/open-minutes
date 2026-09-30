-- Split a meeting's start instant into a wall-clock `date` and a nullable `time`,
-- read in the body's zone, so "we know the day but not the hour" is
-- representable (a null time) instead of being faked as midnight. See ADR 0004.
--
-- Hand-edited: drizzle-kit can't generate this in one step (it asks
-- interactively whether `start_time` was renamed), so the columns are added,
-- backfilled by the UPDATE, and only then is `start_time` dropped. A start_time is an
-- instant, so it is converted to the wall clock of the body's own zone — the
-- same reading the web app used to render — before being split. Every
-- start_time is null in practice (ingestion can't derive one), but a migration
-- that is only correct on empty data isn't correct.

ALTER TABLE "meetings" ADD COLUMN "date" date;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "time" time;--> statement-breakpoint
UPDATE "meetings" AS m
  SET "date" = (m."start_time" AT TIME ZONE b."timezone")::date,
      "time" = (m."start_time" AT TIME ZONE b."timezone")::time
  FROM "bodies" AS b
  WHERE b."id" = m."body_id" AND m."start_time" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_time_requires_date" CHECK ("time" IS NULL OR "date" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "start_time";
