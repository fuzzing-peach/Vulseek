CREATE TABLE IF NOT EXISTS "scan_pipeline_profiles" (
	"pipelineProfileId" text PRIMARY KEY NOT NULL,
	"pipelineId" text NOT NULL REFERENCES "scan_pipelines"("pipelineId") ON DELETE cascade,
	"pipelineVersionId" text NOT NULL REFERENCES "scan_pipeline_versions"("pipelineVersionId") ON DELETE cascade,
	"organizationId" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"description" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "scan_pipeline_profiles_pipeline_name_unique"
	ON "scan_pipeline_profiles" ("pipelineId", "name");
CREATE INDEX IF NOT EXISTS "scan_pipeline_profiles_org_pipeline_idx"
	ON "scan_pipeline_profiles" ("organizationId", "pipelineId");
