-- Two halves of one decision: a meeting's start time is an *instant*, and the
-- wall-clock time that was on the agenda is derived from it via the body's zone.
--
-- Hand-edited from the generated diff on both statements:
--
-- 1. The generated `ADD COLUMN "timezone" varchar NOT NULL` would fail on any
--    database that already has bodies in it. Added nullable, backfilled, then
--    tightened. Every body so far meets inside the Municipality of Anchorage, so
--    America/Anchorage is the true value and not a placeholder; bodies added
--    later must supply their own.
--
-- 2. The generated cast was a bare `"start_time"::timestamptz`, which reads the
--    naive value in whatever the *session* TimeZone happens to be — so the same
--    migration would produce different instants depending on who ran it. Drizzle
--    has always written this column as UTC (it appends '+0000' on read), so
--    `AT TIME ZONE 'UTC'` is what actually names the old semantics. Every
--    start_time is null today, since ingestion can't derive one, but a migration
--    that is only correct on empty data isn't correct.

ALTER TABLE "bodies" ADD COLUMN "timezone" varchar;--> statement-breakpoint
UPDATE "bodies" SET "timezone" = 'America/Anchorage' WHERE "timezone" IS NULL;--> statement-breakpoint
ALTER TABLE "bodies" ALTER COLUMN "timezone" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "meetings" ALTER COLUMN "start_time" SET DATA TYPE timestamp with time zone
  USING "start_time" AT TIME ZONE 'UTC';
