ALTER TABLE "people" ADD COLUMN "slug" varchar;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_slug_key" UNIQUE("slug");