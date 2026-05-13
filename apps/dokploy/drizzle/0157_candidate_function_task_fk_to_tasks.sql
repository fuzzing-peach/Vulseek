ALTER TABLE "vulnerability_candidates"
	DROP CONSTRAINT IF EXISTS "vulnerability_candidates_scanFunctionTaskId_scan_function_tasks_scanFunctionTaskId_fk";

ALTER TABLE "vulnerability_candidates"
	ADD CONSTRAINT "vulnerability_candidates_scanFunctionTaskId_tasks_taskId_fk"
	FOREIGN KEY ("scanFunctionTaskId") REFERENCES "public"."tasks"("taskId")
	ON DELETE set null ON UPDATE no action;
