export const SCAN_STAGE_METADATA = {
	deltaScope: {
		id: "delta-scope",
		name: "Delta Scope",
	},
	repositoryScan: {
		id: "repository-scan",
		name: "Scan Repository",
	},
	moduleScan: {
		id: "module-scan",
		name: "Scan Module",
	},
	functionScan: {
		id: "function-scan",
		name: "Scan Function",
	},
	analysis: {
		id: "analyze",
		name: "Analyze",
	},
	fuzzBuild: {
		id: "build-fuzzer",
		name: "Build Fuzzer",
	},
	fuzzRun: {
		id: "run-fuzzer",
		name: "Run Fuzzer",
	},
	analysisCritic: {
		id: "criticize",
		name: "Criticize",
	},
	verification: {
		id: "verify",
		name: "Verify",
	},
	triage: {
		id: "triage",
		name: "Triage",
	},
} as const;

export type ScanStageKey = keyof typeof SCAN_STAGE_METADATA;
export type ScanStageId = (typeof SCAN_STAGE_METADATA)[ScanStageKey]["id"];

export const SCAN_STAGE_IDS = Object.fromEntries(
	Object.entries(SCAN_STAGE_METADATA).map(([key, value]) => [key, value.id]),
) as { [K in ScanStageKey]: (typeof SCAN_STAGE_METADATA)[K]["id"] };

export const SCAN_STAGE_DISPLAY_NAMES = Object.fromEntries(
	Object.entries(SCAN_STAGE_METADATA).map(([key, value]) => [key, value.name]),
) as { [K in ScanStageKey]: (typeof SCAN_STAGE_METADATA)[K]["name"] };

export const SCAN_STAGE_ID_TO_DISPLAY_NAME = Object.fromEntries(
	Object.values(SCAN_STAGE_METADATA).map((value) => [value.id, value.name]),
) as Record<ScanStageId, string>;

export const getScanStageDisplayName = (stageName: string) =>
	SCAN_STAGE_ID_TO_DISPLAY_NAME[stageName as ScanStageId] || stageName;
