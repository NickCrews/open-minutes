-- Splits the old flat `municipalities` table into `jurisdictions` (the
-- government) and `bodies` (the thing that actually meets), and moves YouTube
-- off the government onto `video_sources`.
--
-- Hand-edited from the generated diff, which wanted to DROP TABLE
-- "municipalities" and add a NOT NULL "meetings"."body_id" — that would have
-- discarded every existing row and failed on a non-empty meetings table. The
-- backfill below carries the data across instead.

CREATE TABLE "bodies" (
	"id" serial PRIMARY KEY,
	"jurisdiction_id" integer NOT NULL,
	"name" varchar DEFAULT '' NOT NULL,
	"name_short" varchar DEFAULT '' NOT NULL,
	"homepage_url" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jurisdictions" (
	"id" serial PRIMARY KEY,
	"name" varchar DEFAULT '' NOT NULL,
	"name_short" varchar DEFAULT '' NOT NULL,
	"state" varchar DEFAULT '' NOT NULL,
	"postcode" varchar DEFAULT '',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_sources" (
	"id" serial PRIMARY KEY,
	"body_id" integer NOT NULL,
	"kind" varchar NOT NULL,
	"youtube_id" varchar NOT NULL,
	"url" varchar GENERATED ALWAYS AS (CASE "video_sources"."kind"
            WHEN 'channel' THEN 'https://www.youtube.com/channel/' || "video_sources"."youtube_id"
            WHEN 'playlist' THEN 'https://www.youtube.com/playlist?list=' || "video_sources"."youtube_id"
          END) STORED,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_jurisdiction_id_jurisdictions_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("id");--> statement-breakpoint
ALTER TABLE "video_sources" ADD CONSTRAINT "video_sources_body_id_bodies_id_fkey" FOREIGN KEY ("body_id") REFERENCES "bodies"("id");--> statement-breakpoint

-- Temporary id maps, dropped at the end of this migration, so the backfill can
-- repoint meetings without a round-trip through application code.
ALTER TABLE "jurisdictions" ADD COLUMN "legacy_municipality_id" integer;--> statement-breakpoint
ALTER TABLE "bodies" ADD COLUMN "legacy_municipality_id" integer;--> statement-breakpoint

-- The old table couldn't distinguish the two, so each row becomes both: a
-- jurisdiction, and one body inside it holding that row's meetings.
INSERT INTO "jurisdictions" ("name", "name_short", "state", "postcode", "created_at", "legacy_municipality_id")
SELECT "name", "name_short", "state", "postcode", "created_at", "id" FROM "municipalities";--> statement-breakpoint

INSERT INTO "bodies" ("jurisdiction_id", "name", "name_short", "created_at", "legacy_municipality_id")
SELECT j."id", m."name", m."name_short", m."created_at", m."id"
FROM "municipalities" m
JOIN "jurisdictions" j ON j."legacy_municipality_id" = m."id";--> statement-breakpoint

INSERT INTO "video_sources" ("body_id", "kind", "youtube_id", "created_at")
SELECT b."id", 'channel', m."youtube_channel_id", m."created_at"
FROM "municipalities" m
JOIN "bodies" b ON b."legacy_municipality_id" = m."id"
WHERE m."youtube_channel_id" IS NOT NULL AND m."youtube_channel_id" <> '';--> statement-breakpoint

-- GBOS and the Anchorage Assembly are both bodies *within* the Municipality of
-- Anchorage, not governments of their own — precisely the distinction the old
-- table couldn't make, which is why both sat in it as top-level rows. Reparent
-- them under a real MOA jurisdiction and drop the placeholder jurisdictions the
-- generic backfill above gave them.
INSERT INTO "jurisdictions" ("name", "name_short", "state")
SELECT 'Municipality of Anchorage', 'MOA', 'AK'
WHERE EXISTS (SELECT 1 FROM "bodies" WHERE "name_short" IN ('GBOS', 'Anchorage Assembly'))
  AND NOT EXISTS (SELECT 1 FROM "jurisdictions" WHERE "name_short" = 'MOA');--> statement-breakpoint

UPDATE "bodies" SET "jurisdiction_id" = (SELECT "id" FROM "jurisdictions" WHERE "name_short" = 'MOA')
WHERE "name_short" IN ('GBOS', 'Anchorage Assembly');--> statement-breakpoint

-- Now that the Assembly is a body, its short name can be the actual short name
-- the old schema had no room for (it doubles as the `--body` CLI slug).
UPDATE "bodies" SET "name_short" = 'Assembly' WHERE "name_short" = 'Anchorage Assembly';--> statement-breakpoint

DELETE FROM "jurisdictions" j
WHERE j."name_short" IN ('GBOS', 'Anchorage Assembly')
  AND NOT EXISTS (SELECT 1 FROM "bodies" b WHERE b."jurisdiction_id" = j."id");--> statement-breakpoint

-- Repoint meetings at their body. Added nullable, backfilled, then tightened,
-- so this works on a database that already has meetings in it.
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_municipality_id_municipalities_id_fkey";--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "body_id" integer;--> statement-breakpoint
UPDATE "meetings" m SET "body_id" = b."id"
FROM "bodies" b WHERE b."legacy_municipality_id" = m."municipality_id";--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "body_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "municipality_id";--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_body_id_bodies_id_fkey" FOREIGN KEY ("body_id") REFERENCES "bodies"("id");--> statement-breakpoint

DROP TABLE "municipalities";--> statement-breakpoint
ALTER TABLE "jurisdictions" DROP COLUMN "legacy_municipality_id";--> statement-breakpoint
ALTER TABLE "bodies" DROP COLUMN "legacy_municipality_id";
