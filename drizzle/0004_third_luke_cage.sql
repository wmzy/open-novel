CREATE INDEX "conversations_project_created_idx" ON "conversations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_conversation_created_idx" ON "runs" USING btree ("conversation_id","created_at");