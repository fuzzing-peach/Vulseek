DO $$
DECLARE
	old_names text[] := ARRAY[
		'delta_scoping',
		'repository-scan',
		'repository_scanning',
		'attack_surface_modeling',
		'module-scan',
		'module_scanning',
		'function-scan',
		'function_scanning',
		'candidate-analysis',
		'analyze',
		'analyzing',
		'analysis-critic',
		'criticize',
		'criticizing',
		'candidate-verification',
		'verify',
		'verifying',
		'candidate-triage',
		'triage',
		'triaging'
	];
	new_names text[] := ARRAY[
		'delta-scope',
		'repository-profile',
		'repository-profile',
		'attack-surface-model',
		'identify-target',
		'identify-target',
		'scan-target',
		'scan-target',
		'analyze-finding',
		'analyze-finding',
		'analyze-finding',
		'critique-finding',
		'critique-finding',
		'critique-finding',
		'verify-finding',
		'verify-finding',
		'verify-finding',
		'triage-finding',
		'triage-finding',
		'triage-finding'
	];
	old_name text;
	new_name text;
	i integer;
BEGIN
	FOR i IN 1..array_length(old_names, 1) LOOP
		old_name := old_names[i];
		new_name := new_names[i];

		DELETE FROM "scan_stage_lane_runtimes" old_row
		WHERE old_row."stageName" = old_name
			AND EXISTS (
				SELECT 1
				FROM "scan_stage_lane_runtimes" new_row
				WHERE new_row."scanJobId" = old_row."scanJobId"
					AND new_row."stageName" = new_name
					AND new_row."laneIndex" = old_row."laneIndex"
			);

		DELETE FROM "scan_stage_group_lane_memberships" old_row
		WHERE old_row."stageName" = old_name
			AND EXISTS (
				SELECT 1
				FROM "scan_stage_group_lane_memberships" new_row
				WHERE new_row."groupInstanceId" = old_row."groupInstanceId"
					AND new_row."stageName" = new_name
			);

		UPDATE "tasks" SET "stageName" = new_name WHERE "stageName" = old_name;
		UPDATE "scan_stage_lane_runtimes" SET "stageName" = new_name WHERE "stageName" = old_name;
		UPDATE "scan_stage_group_instances" SET "leaderStageName" = new_name WHERE "leaderStageName" = old_name;
		UPDATE "scan_stage_group_lane_memberships" SET "stageName" = new_name WHERE "stageName" = old_name;
		UPDATE "vulnerability_candidates" SET "producerStageName" = new_name WHERE "producerStageName" = old_name;

		UPDATE "application"
		SET "scanStageSettings" =
			("scanStageSettings" - old_name) ||
			CASE
				WHEN "scanStageSettings" ? new_name THEN '{}'::jsonb
				ELSE jsonb_build_object(new_name, "scanStageSettings" -> old_name)
			END
		WHERE "scanStageSettings" ? old_name;

		UPDATE "compose"
		SET "scanStageSettings" =
			("scanStageSettings" - old_name) ||
			CASE
				WHEN "scanStageSettings" ? new_name THEN '{}'::jsonb
				ELSE jsonb_build_object(new_name, "scanStageSettings" -> old_name)
			END
		WHERE "scanStageSettings" ? old_name;

		UPDATE "scan_jobs"
		SET "scanRuntimeSettings" = jsonb_set(
			"scanRuntimeSettings",
			'{stages}',
			(("scanRuntimeSettings" -> 'stages') - old_name) ||
				CASE
					WHEN ("scanRuntimeSettings" -> 'stages') ? new_name THEN '{}'::jsonb
					ELSE jsonb_build_object(new_name, "scanRuntimeSettings" -> 'stages' -> old_name)
				END,
			false
		)
		WHERE ("scanRuntimeSettings" -> 'stages') ? old_name;

		UPDATE "scan_jobs"
		SET "scanPipelineDefinitionSnapshot" = replace(
			"scanPipelineDefinitionSnapshot"::text,
			'"' || old_name || '"',
			'"' || new_name || '"'
		)::jsonb
		WHERE "scanPipelineDefinitionSnapshot"::text LIKE ('%"' || old_name || '"%');
	END LOOP;
END $$;
