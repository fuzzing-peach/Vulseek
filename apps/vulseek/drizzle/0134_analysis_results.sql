CREATE TABLE "analysis_results" (
	"analysisResultId" text PRIMARY KEY NOT NULL,
	"scanJobId" text NOT NULL,
	"vulnerabilityCandidateId" text NOT NULL,
	"result" text NOT NULL,
	"reportPath" text,
	"runtimeSeconds" real,
	"threadId" text,
	"summary" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

ALTER TABLE "analysis_results"
ADD CONSTRAINT "analysis_results_scanJobId_scan_jobs_scanJobId_fk"
FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId")
ON DELETE cascade ON UPDATE no action;

ALTER TABLE "analysis_results"
ADD CONSTRAINT "analysis_results_vulnerabilityCandidateId_vulnerability_candidates_vulnerabilityCandidateId_fk"
FOREIGN KEY ("vulnerabilityCandidateId") REFERENCES "public"."vulnerability_candidates"("vulnerabilityCandidateId")
ON DELETE cascade ON UPDATE no action;

CREATE INDEX "analysis_results_scan_job_idx"
ON "analysis_results" USING btree ("scanJobId");

CREATE INDEX "analysis_results_candidate_idx"
ON "analysis_results" USING btree ("vulnerabilityCandidateId");

INSERT INTO "analysis_results" (
	"analysisResultId",
	"scanJobId",
	"vulnerabilityCandidateId",
	"result",
	"reportPath",
	"runtimeSeconds",
	"threadId",
	"summary",
	"createdAt",
	"updatedAt"
)
SELECT
	sf."scanFindingId",
	vc."scanJobId",
	sf."vulnerabilityCandidateId",
	COALESCE(
		NULLIF((regexp_match(sf."detail", '(?m)^- result:\s*(.+)$'))[1], ''),
		'plausible_but_unproven'
	),
	NULLIF((regexp_match(sf."detail", '(?m)^- report_path:\s*(.+)$'))[1], ''),
	CASE
		WHEN NULLIF((regexp_match(sf."detail", '(?m)^- runtime_seconds:\s*(.+)$'))[1], '') IS NULL THEN NULL
		ELSE CAST(NULLIF((regexp_match(sf."detail", '(?m)^- runtime_seconds:\s*(.+)$'))[1], '') AS real)
	END,
	NULLIF((regexp_match(sf."detail", '(?m)^- thread_id:\s*(.+)$'))[1], ''),
	COALESCE(
		NULLIF((regexp_match(sf."detail", '(?s)## Summary\s+(.+)$'))[1], ''),
		sf."title"
	),
	sf."createdAt",
	sf."createdAt"
FROM "scan_findings" sf
INNER JOIN "vulnerability_candidates" vc
ON vc."vulnerabilityCandidateId" = sf."vulnerabilityCandidateId";

DROP TABLE "scan_findings";
