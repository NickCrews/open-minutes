-- bodies.slug and jurisdictions.slug: stable handles in lowercase kebab-case.
-- Every slug column, including meetings.slug and people.slug, must be
-- lowercase kebab-case. jurisdictions.name_short goes, once the backfill
-- has used it. See schema.ts.
--
-- Hand-edited: existing rows are backfilled before the columns become NOT
-- NULL. A slug is name_short (or name, if that's empty) in kebab-case, eg
-- "GBOS" -> "gbos"; a row whose name gives none gets "<table>-<id>", and all
-- but the first of rows that would share one get "-<id>" appended. The State
-- of Alaska gets "ak", the slug the fixtures give it.

ALTER TABLE "bodies" ADD COLUMN "slug" varchar;--> statement-breakpoint
ALTER TABLE "jurisdictions" ADD COLUMN "slug" varchar;--> statement-breakpoint
UPDATE "bodies" SET "slug" = derived.slug
FROM (
	SELECT id,
		CASE
			WHEN base = '' THEN 'body-' || id
			WHEN row_number() OVER (PARTITION BY base ORDER BY id) > 1 THEN base || '-' || id
			ELSE base
		END AS slug
	FROM (
		SELECT id, trim(BOTH '-' FROM lower(regexp_replace(coalesce(nullif(name_short, ''), name), '[^A-Za-z0-9]+', '-', 'g'))) AS base
		FROM "bodies"
	) AS bases
) AS derived
WHERE "bodies"."id" = derived.id;--> statement-breakpoint
UPDATE "jurisdictions" SET "slug" = CASE WHEN "name" = 'State of Alaska' THEN 'ak' ELSE derived.slug END
FROM (
	SELECT id,
		CASE
			WHEN base = '' THEN 'jurisdiction-' || id
			WHEN row_number() OVER (PARTITION BY base ORDER BY id) > 1 THEN base || '-' || id
			ELSE base
		END AS slug
	FROM (
		SELECT id, trim(BOTH '-' FROM lower(regexp_replace(coalesce(nullif(name_short, ''), name), '[^A-Za-z0-9]+', '-', 'g'))) AS base
		FROM "jurisdictions"
	) AS bases
) AS derived
WHERE "jurisdictions"."id" = derived.id;--> statement-breakpoint
ALTER TABLE "bodies" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jurisdictions" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_slug_key" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "jurisdictions" ADD CONSTRAINT "jurisdictions_slug_key" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');--> statement-breakpoint
ALTER TABLE "jurisdictions" ADD CONSTRAINT "jurisdictions_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_slug_valid" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');--> statement-breakpoint
ALTER TABLE "jurisdictions" DROP COLUMN "name_short";
