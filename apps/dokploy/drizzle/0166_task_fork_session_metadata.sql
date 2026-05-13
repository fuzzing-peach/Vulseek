ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "runtimeMode" text DEFAULT 'new_session';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "forkedFromTaskId" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "forkedFromThreadId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_forkedFromTaskId_tasks_taskId_fk"
 FOREIGN KEY ("forkedFromTaskId") REFERENCES "public"."tasks"("taskId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_forked_from_task_idx" ON "tasks" USING btree ("forkedFromTaskId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_forked_from_thread_idx" ON "tasks" USING btree ("forkedFromThreadId");
