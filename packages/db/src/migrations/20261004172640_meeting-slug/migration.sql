-- meetings.slug: a stable handle for the golden fixture meetings, the way
-- people.slug is for people. See schema.ts.
--
-- Hand-edited: the UPDATE at the end backfills the golden meetings already in
-- a database (dev databases, and prod if it has ingested the same videos), by
-- YouTube id. The dev seeders set slugs themselves from here on.

ALTER TABLE "meetings" ADD COLUMN "slug" varchar;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_slug_key" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_slug_not_numeric" CHECK ("slug" !~ '^[0-9]+$');--> statement-breakpoint
UPDATE "meetings" SET "slug" = golden.slug
FROM (VALUES
	('SGNnYNW26aQ', 'assembly_SGNnYNW26aQ'),
	('vJURFS21w-w', 'assembly_vJURFS21w-w'),
	('hK1Sq1a7aQM', 'ced_hK1Sq1a7aQM'),
	('9HoIM5INxpI', 'gbos_9HoIM5INxpI'),
	('hTKVG_L61ec', 'gbos_hTKVG_L61ec'),
	('xTDznaSElgY', 'gbos_xTDznaSElgY'),
	('DwFHRjobjcY', 'pzc_DwFHRjobjcY')
) AS golden(youtube_id, slug)
WHERE "meetings"."youtube_id" = golden.youtube_id;
