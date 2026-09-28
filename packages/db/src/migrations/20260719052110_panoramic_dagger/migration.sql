ALTER TABLE "people" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "people" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
-- Collapse the two old "we don't know who this is" spellings onto null. The
-- pipeline used to stamp new people with the literal name "Unknown Speaker",
-- which made every unidentified voice look identified to the UI.
UPDATE "people" SET "name" = NULL WHERE "name" = '' OR "name" = 'Unknown Speaker';
