const EXPECTED_SCAN_STAGE_KEYS = [
	"deltaScope",
	"repositoryProfile",
	"identifyTarget",
	"attackSurfaceModel",
	"scanTarget",
	"analyzeFinding",
	"critiqueFinding",
	"verifyFinding",
	"triageFinding",
] as const;

type RequiredScanStageMetadata = Record<
	(typeof EXPECTED_SCAN_STAGE_KEYS)[number],
	{ id: string; name: string }
>;

export const SCAN_STAGE_METADATA: RequiredScanStageMetadata = {
	deltaScope: { id: "delta-scope", name: "Delta Scope" },
	repositoryProfile: { id: "repository-profile", name: "Repository Profile" },
	identifyTarget: { id: "identify-target", name: "Identify Target" },
	attackSurfaceModel: {
		id: "attack-surface-model",
		name: "Attack Surface Model",
	},
	scanTarget: { id: "scan-target", name: "Scan Target" },
	analyzeFinding: { id: "analyze-finding", name: "Analyze Finding" },
	critiqueFinding: { id: "critique-finding", name: "Critique Finding" },
	verifyFinding: { id: "verify-finding", name: "Verify Finding" },
	triageFinding: { id: "triage-finding", name: "Triage Finding" },
};

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
