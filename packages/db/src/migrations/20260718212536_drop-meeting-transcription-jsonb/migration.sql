ALTER TABLE "segments" ADD COLUMN "speaker_number" integer;--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "transcription";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "diarization";