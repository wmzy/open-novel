ALTER TABLE "runs" ADD COLUMN "mode" varchar(20) DEFAULT 'generate' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "payload" jsonb;