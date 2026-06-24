export const SCAN_STAGE_METADATA = {
	deltaScope: {
		id: "delta-scope",
		name: "Delta Scope",
	},
	repositoryScan: {
		id: "repository-profile",
		name: "Repository Profile",
	},
	moduleScan: {
		id: "identify-target",
		name: "Identify Target",
	},
	attackSurfaceModel: {
		id: "attack-surface-model",
		name: "Attack Surface Model",
	},
	moduleThreatModel: {
		id: "module-threat-model",
		name: "Module Threat Model",
	},
	ruleDesign: {
		id: "design-rule",
		name: "Design Rule",
	},
	ruleScan: {
		id: "scan-rule",
		name: "Scan Rule",
	},
	patternScan: {
		id: "scan-pattern",
		name: "Scan Pattern",
	},
	sinkPreAnalyze: {
		id: "sink-pre-analyze",
		name: "Sink Pre-Analyze",
	},
	functionScan: {
		id: "scan-target",
		name: "Scan Target",
	},
	analysis: {
		id: "analyze-finding",
		name: "Analyze Finding",
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
		id: "critique-finding",
		name: "Critique Finding",
	},
	verification: {
		id: "verify-finding",
		name: "Verify Finding",
	},
	triage: {
		id: "triage-finding",
		name: "Triage Finding",
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
	SCAN_STAGE_ID_TO_DISPLAY_NAME[stageName as ScanStageId] ||
	LEGACY_SCAN_STAGE_DISPLAY_NAMES[stageName] ||
	stageName;

export const LEGACY_SCAN_STAGE_DISPLAY_NAMES: Record<string, string> = {
	"repository-scan": "Scan Repository",
	"module-scan": "Scan Module",
	"function-scan": "Scan Function",
	analyze: "Analyze",
	criticize: "Criticize",
	verify: "Verify",
	triage: "Triage",
	"build-fuzzer": "Build Fuzzer",
	"run-fuzzer": "Run Fuzzer",
};
