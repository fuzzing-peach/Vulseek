DO $$
DECLARE
  legacy_scan_stage_keys text[] := ARRAY[
    'repository-scan',
    'module-scan',
    'function-scan',
    'analyze',
    'criticize',
    'verify',
    'triage',
    'build-fuzzer',
    'run-fuzzer',
    'module-threat-model',
    'sink-pre-analyze',
    'design-rule',
    'scan-pattern',
    'scan-rule',
    'rule-design',
    'rule-scan',
    'pattern-scan'
  ];
BEGIN
  UPDATE "application"
  SET "scanStageSettings" =
    "scanStageSettings"
    - 'repository-scan'
    - 'module-scan'
    - 'function-scan'
    - 'analyze'
    - 'criticize'
    - 'verify'
    - 'triage'
    - 'build-fuzzer'
    - 'run-fuzzer'
    - 'module-threat-model'
    - 'sink-pre-analyze'
    - 'design-rule'
    - 'scan-pattern'
    - 'scan-rule'
    - 'rule-design'
    - 'rule-scan'
    - 'pattern-scan'
  WHERE "scanStageSettings" ?| legacy_scan_stage_keys;

  UPDATE "compose"
  SET "scanStageSettings" =
    "scanStageSettings"
    - 'repository-scan'
    - 'module-scan'
    - 'function-scan'
    - 'analyze'
    - 'criticize'
    - 'verify'
    - 'triage'
    - 'build-fuzzer'
    - 'run-fuzzer'
    - 'module-threat-model'
    - 'sink-pre-analyze'
    - 'design-rule'
    - 'scan-pattern'
    - 'scan-rule'
    - 'rule-design'
    - 'rule-scan'
    - 'pattern-scan'
  WHERE "scanStageSettings" ?| legacy_scan_stage_keys;

  UPDATE "scan_jobs"
  SET "scanRuntimeSettings" = jsonb_set(
    "scanRuntimeSettings",
    '{stages}',
    ("scanRuntimeSettings"->'stages')
      - 'repository-scan'
      - 'module-scan'
      - 'function-scan'
      - 'analyze'
      - 'criticize'
      - 'verify'
      - 'triage'
      - 'build-fuzzer'
      - 'run-fuzzer'
      - 'module-threat-model'
      - 'sink-pre-analyze'
      - 'design-rule'
      - 'scan-pattern'
      - 'scan-rule'
      - 'rule-design'
      - 'rule-scan'
      - 'pattern-scan',
    false
  )
  WHERE ("scanRuntimeSettings"->'stages') ?| legacy_scan_stage_keys;

  UPDATE "vulnerability_candidates"
  SET "currentStage" = 'analyzing'
  WHERE "currentStage" = 'fuzzing';
END $$;
