ALTER TABLE "scan_repository_tasks"
  DROP COLUMN IF EXISTS "repositoryScanMdPath",
  DROP COLUMN IF EXISTS "repositoryScanJsonPath",
  DROP COLUMN IF EXISTS "modulePlanJsonPath";

ALTER TABLE "scan_module_tasks"
  DROP COLUMN IF EXISTS "moduleScanMdPath",
  DROP COLUMN IF EXISTS "moduleScanJsonPath",
  DROP COLUMN IF EXISTS "functionPlanJsonPath";

ALTER TABLE "scan_function_tasks"
  DROP COLUMN IF EXISTS "functionScanMdPath",
  DROP COLUMN IF EXISTS "functionScanJsonPath";
