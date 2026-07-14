UPDATE "scan_jobs"
SET "scanPipelineDefinitionSnapshot" = replace(
	replace(
		replace(
			replace(
				replace(
					"scanPipelineDefinitionSnapshot"::text,
					'"scan-repository.prompt.md"',
					'"repository-profile.prompt.md"'
				),
				'"analyze.prompt.md"',
				'"analyze-finding.prompt.md"'
			),
			'"criticize.prompt.md"',
			'"critique-finding.prompt.md"'
		),
		'"verify.prompt.md"',
		'"verify-finding.prompt.md"'
	),
	'"triage.prompt.md"',
	'"triage-finding.prompt.md"'
)::jsonb
WHERE "scanPipelineDefinitionSnapshot"::text ~
	'"(scan-repository|analyze|criticize|verify|triage)\.prompt\.md"';
