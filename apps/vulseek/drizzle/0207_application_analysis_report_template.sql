ALTER TABLE "application"
	ADD COLUMN IF NOT EXISTS "analysisReportTemplate" text NOT NULL DEFAULT '';
