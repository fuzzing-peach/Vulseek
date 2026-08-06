-- Organization-level pipeline management (V3 pipeline documents).
-- Tables: scan_pipelines (one shared draft + current version pointer),
-- scan_pipeline_versions (immutable append-only published versions).

CREATE TYPE "scanPipelineVersionSource" AS ENUM ('user', 'system', 'migration');

CREATE TABLE IF NOT EXISTS "scan_pipelines" (
	"pipelineId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"draftYaml" text,
	"draftRevision" integer NOT NULL DEFAULT 0,
	"draftBaseVersionId" text,
	"currentPublishedVersionId" text,
	"systemKey" text,
	"archivedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	"createdBy" text,
	"updatedBy" text
);

CREATE TABLE IF NOT EXISTS "scan_pipeline_versions" (
	"pipelineVersionId" text PRIMARY KEY NOT NULL,
	"pipelineId" text NOT NULL,
	"versionNumber" integer NOT NULL,
	"yaml" text NOT NULL,
	"contentHash" text NOT NULL,
	"compiledDefinition" jsonb,
	"source" "scanPipelineVersionSource" NOT NULL DEFAULT 'user',
	"publishedBy" text,
	"publishedAt" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "scan_pipelines_org_slug_unique"
	ON "scan_pipelines" ("organizationId", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "scan_pipelines_system_key_unique"
	ON "scan_pipelines" ("organizationId", "systemKey")
	WHERE "systemKey" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "scan_pipeline_versions_pipeline_number_unique"
	ON "scan_pipeline_versions" ("pipelineId", "versionNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "scan_pipeline_versions_content_hash_unique"
	ON "scan_pipeline_versions" ("pipelineId", "contentHash")
	WHERE "contentHash" IS NOT NULL;

-- scan_jobs: frozen pipeline linkage + loop-safety limits.
ALTER TABLE "scan_jobs"
	ADD COLUMN IF NOT EXISTS "pipelineId" text,
	ADD COLUMN IF NOT EXISTS "pipelineVersionId" text,
	ADD COLUMN IF NOT EXISTS "pipelineYamlSnapshot" text,
	ADD COLUMN IF NOT EXISTS "pipelineCompiledSnapshot" jsonb,
	ADD COLUMN IF NOT EXISTS "maxTasks" integer,
	ADD COLUMN IF NOT EXISTS "deadlineAt" text,
	ADD COLUMN IF NOT EXISTS "taskCount" integer NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS "terminationReason" text;

-- dataset_evaluations: legacy key rename + real pipeline linkage.
ALTER TABLE "dataset_evaluations"
	ADD COLUMN IF NOT EXISTS "legacyPipelineKey" text,
	ADD COLUMN IF NOT EXISTS "pipelineId" text,
	ADD COLUMN IF NOT EXISTS "pipelineVersionId" text,
	ADD COLUMN IF NOT EXISTS "pipelineYamlSnapshot" text,
	ADD COLUMN IF NOT EXISTS "pipelineCompiledSnapshot" jsonb;

UPDATE "dataset_evaluations" SET "legacyPipelineKey" = "pipelineId"
	WHERE "legacyPipelineKey" IS NULL AND "pipelineId" IS NOT NULL;

ALTER TABLE "dataset_evaluations" DROP COLUMN IF EXISTS "pipelineId";

-- Profiles default pipeline pointer.
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "defaultPipelineId" text;
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "defaultPipelineId" text;

-- Foreign keys (installed last so column creation order never matters).
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'scan_pipelines_organizationId_organization_id_fk'
	) THEN
		ALTER TABLE "scan_pipelines"
			ADD CONSTRAINT "scan_pipelines_organizationId_organization_id_fk"
			FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'scan_pipeline_versions_pipelineId_scan_pipelines_pipelineId_fk'
	) THEN
		ALTER TABLE "scan_pipeline_versions"
			ADD CONSTRAINT "scan_pipeline_versions_pipelineId_scan_pipelines_pipelineId_fk"
			FOREIGN KEY ("pipelineId") REFERENCES "scan_pipelines"("pipelineId") ON DELETE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'scan_jobs_pipelineId_scan_pipelines_pipelineId_fk'
	) THEN
		ALTER TABLE "scan_jobs"
			ADD CONSTRAINT "scan_jobs_pipelineId_scan_pipelines_pipelineId_fk"
			FOREIGN KEY ("pipelineId") REFERENCES "scan_pipelines"("pipelineId") ON DELETE set null;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'scan_jobs_pipelineVersionId_scan_pipeline_versions_pipelineVersionId_fk'
	) THEN
		ALTER TABLE "scan_jobs"
			ADD CONSTRAINT "scan_jobs_pipelineVersionId_scan_pipeline_versions_pipelineVersionId_fk"
			FOREIGN KEY ("pipelineVersionId") REFERENCES "scan_pipeline_versions"("pipelineVersionId") ON DELETE set null;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'dataset_evaluations_pipelineId_scan_pipelines_pipelineId_fk'
	) THEN
		ALTER TABLE "dataset_evaluations"
			ADD CONSTRAINT "dataset_evaluations_pipelineId_scan_pipelines_pipelineId_fk"
			FOREIGN KEY ("pipelineId") REFERENCES "scan_pipelines"("pipelineId") ON DELETE set null;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'dataset_evaluations_pipelineVersionId_scan_pipeline_versions_pipelineVersionId_fk'
	) THEN
		ALTER TABLE "dataset_evaluations"
			ADD CONSTRAINT "dataset_evaluations_pipelineVersionId_scan_pipeline_versions_pipelineVersionId_fk"
			FOREIGN KEY ("pipelineVersionId") REFERENCES "scan_pipeline_versions"("pipelineVersionId") ON DELETE set null;
	END IF;
END $$;
