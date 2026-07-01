CREATE TABLE "chapters" (
	"id" varchar(25) PRIMARY KEY NOT NULL,
	"project_id" varchar(25) NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(200),
	"word_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" varchar(25) PRIMARY KEY NOT NULL,
	"project_id" varchar(25) NOT NULL,
	"agent_id" varchar(50) NOT NULL,
	"stage" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar(25) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(25) NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" varchar(100000) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar(25) PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"path" varchar(500) NOT NULL,
	"genre" varchar(50) DEFAULT 'general' NOT NULL,
	"target_words" integer DEFAULT 100000 NOT NULL,
	"chapter_count" integer DEFAULT 20 NOT NULL,
	"theme" varchar(500),
	"perspective" varchar(50) DEFAULT 'third-person' NOT NULL,
	"current_stage" varchar(50) DEFAULT 'concept' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(25),
	"agent" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" varchar(25) PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" varchar(5000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chapters_project_number_idx" ON "chapters" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "projects_created_at_idx" ON "projects" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_settings_key_idx" ON "user_settings" USING btree ("key");