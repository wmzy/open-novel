CREATE TABLE "semantic_chunks" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"project_id" varchar(25) NOT NULL,
	"chapter_number" integer NOT NULL,
	"source" varchar(20) NOT NULL,
	"chunk_index" integer NOT NULL,
	"file" varchar(300) NOT NULL,
	"content" varchar(4000) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"model" varchar(150) NOT NULL,
	"embedding" real[] NOT NULL,
	"dim" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "semantic_chunks" ADD CONSTRAINT "semantic_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_chunks_unique_idx" ON "semantic_chunks" USING btree ("project_id","source","chapter_number","chunk_index");--> statement-breakpoint
CREATE INDEX "semantic_chunks_project_idx" ON "semantic_chunks" USING btree ("project_id");