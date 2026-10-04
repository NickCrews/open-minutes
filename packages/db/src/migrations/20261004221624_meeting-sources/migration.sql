-- Each body's video sources become its one meeting source. Production has at
-- most one per body; refuse to pick between several rather than drop any.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "video_sources" GROUP BY "body_id" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'A body has several video sources; delete all but one before migrating';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "bodies" ADD COLUMN "meeting_source" jsonb;--> statement-breakpoint
UPDATE "bodies" b SET "meeting_source" = CASE vs."kind"
    WHEN 'channel' THEN jsonb_build_object('type', 'youtube_channel', 'channel_id', vs."youtube_id")
    WHEN 'playlist' THEN jsonb_build_object('type', 'youtube_playlist', 'playlist_id', vs."youtube_id")
  END
  FROM "video_sources" vs WHERE vs."body_id" = b."id";--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_meeting_source_valid" CHECK ("meeting_source" IS NULL OR coalesce(CASE "meeting_source"->>'type'
      WHEN 'youtube_channel' THEN jsonb_typeof("meeting_source"->'channel_id') = 'string'
      WHEN 'youtube_playlist' THEN jsonb_typeof("meeting_source"->'playlist_id') = 'string'
      WHEN 'akleg_committee' THEN jsonb_typeof("meeting_source"->'committee') = 'string'
      ELSE false END, false));--> statement-breakpoint
-- Every meeting so far is a YouTube video.
ALTER TABLE "meetings" ADD COLUMN "site_kind" varchar;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "site_id" varchar;--> statement-breakpoint
UPDATE "meetings" SET "site_kind" = 'youtube', "site_id" = "youtube_id";--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "site_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "site_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "url" varchar GENERATED ALWAYS AS (CASE "meetings"."site_kind"
            WHEN 'youtube' THEN 'https://www.youtube.com/watch?v=' || "meetings"."site_id"
            WHEN 'akleg' THEN 'https://www.akleg.gov/basis/Meeting/Detail?Meeting=' || replace(replace("meetings"."site_id", '&', '%26'), ' ', '%20')
          END) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_site_kind_site_id_unique" UNIQUE("site_kind","site_id");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_site_kind_known" CHECK ("site_kind" IN ('youtube', 'akleg'));--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "youtube_url";--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_youtube_id_key";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "youtube_id";--> statement-breakpoint
DROP TABLE "video_sources";
