UPDATE "scan_jobs"
SET "scanPipelineDefinitionSnapshot" = jsonb_set(
  "scanPipelineDefinitionSnapshot",
  '{version}',
  '2'::jsonb,
  true
)
WHERE "scanPipelineDefinitionSnapshot" IS NOT NULL
  AND jsonb_typeof("scanPipelineDefinitionSnapshot") = 'object'
  AND "scanPipelineDefinitionSnapshot" ? 'stages'
  AND "scanPipelineDefinitionSnapshot" ? 'pipelines'
  AND (
    NOT ("scanPipelineDefinitionSnapshot" ? 'version')
    OR ("scanPipelineDefinitionSnapshot" ->> 'version') !~ '^[0-9]+$'
    OR ("scanPipelineDefinitionSnapshot" ->> 'version')::integer < 2
  );
