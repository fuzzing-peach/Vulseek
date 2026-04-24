DO $$
BEGIN
    CREATE TYPE "scanPhase" AS ENUM (
        'queued',
        'repository_scanning',
        'module_scanning',
        'function_scanning',
        'analyzing',
        'verifying',
        'completed',
        'failed'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "scanPhase" "scanPhase" DEFAULT 'queued' NOT NULL;

DO $$
BEGIN
    CREATE TYPE "scanTaskStatus" AS ENUM (
        'queued',
        'running',
        'completed',
        'failed'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "repositoryTaskStatus" "scanTaskStatus" DEFAULT 'queued' NOT NULL;

ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "moduleTasksTotal" integer DEFAULT 0 NOT NULL;

ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "moduleTasksCompleted" integer DEFAULT 0 NOT NULL;

ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "moduleTasksFailed" integer DEFAULT 0 NOT NULL;

ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "functionTasksTotal" integer DEFAULT 0 NOT NULL;

ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "functionTasksCompleted" integer DEFAULT 0 NOT NULL;

ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "functionTasksFailed" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "scan_module_tasks" (
    "scanModuleTaskId" text PRIMARY KEY NOT NULL,
    "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE cascade,
    "moduleId" text NOT NULL,
    "moduleName" text NOT NULL,
    "status" "scanTaskStatus" DEFAULT 'queued' NOT NULL,
    "priority" integer DEFAULT 0 NOT NULL,
    "attempt" integer DEFAULT 0 NOT NULL,
    "containerName" text,
    "threadId" text,
    "moduleScanMdPath" text,
    "moduleScanJsonPath" text,
    "functionPlanJsonPath" text,
    "errorMessage" text,
    "startedAt" text,
    "completedAt" text,
    "createdAt" text NOT NULL,
    "updatedAt" text NOT NULL,
    CONSTRAINT "scan_module_tasks_scan_job_module_unique" UNIQUE("scanJobId", "moduleId")
);

CREATE INDEX IF NOT EXISTS "scan_module_tasks_scan_job_idx"
ON "scan_module_tasks" ("scanJobId");

CREATE INDEX IF NOT EXISTS "scan_module_tasks_scan_job_status_idx"
ON "scan_module_tasks" ("scanJobId", "status");

CREATE TABLE IF NOT EXISTS "scan_function_tasks" (
    "scanFunctionTaskId" text PRIMARY KEY NOT NULL,
    "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE cascade,
    "scanModuleTaskId" text NOT NULL REFERENCES "scan_module_tasks"("scanModuleTaskId") ON DELETE cascade,
    "moduleId" text NOT NULL,
    "moduleName" text NOT NULL,
    "functionId" text NOT NULL,
    "functionName" text NOT NULL,
    "filePath" text,
    "line" integer,
    "status" "scanTaskStatus" DEFAULT 'queued' NOT NULL,
    "priority" integer DEFAULT 0 NOT NULL,
    "attempt" integer DEFAULT 0 NOT NULL,
    "score" real,
    "riskType" text,
    "summary" text,
    "containerName" text,
    "threadId" text,
    "functionScanMdPath" text,
    "functionScanJsonPath" text,
    "errorMessage" text,
    "startedAt" text,
    "completedAt" text,
    "createdAt" text NOT NULL,
    "updatedAt" text NOT NULL,
    CONSTRAINT "scan_function_tasks_scan_job_function_unique" UNIQUE("scanJobId", "functionId")
);

CREATE INDEX IF NOT EXISTS "scan_function_tasks_scan_job_idx"
ON "scan_function_tasks" ("scanJobId");

CREATE INDEX IF NOT EXISTS "scan_function_tasks_scan_job_status_idx"
ON "scan_function_tasks" ("scanJobId", "status");

CREATE INDEX IF NOT EXISTS "scan_function_tasks_scan_module_task_idx"
ON "scan_function_tasks" ("scanModuleTaskId");
