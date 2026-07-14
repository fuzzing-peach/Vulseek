import { SCAN_PIPELINE_DEFINITIONS } from "./pipeline/scan-pipeline-definitions";

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

const requireStageMetadata = (): RequiredScanStageMetadata => {
	const metadata = SCAN_PIPELINE_DEFINITIONS.stageMetadata;
	for (const key of EXPECTED_SCAN_STAGE_KEYS) {
		if (!metadata[key]) {
			throw new Error(`Missing scan stage metadata for key ${key}`);
		}
	}
	return metadata as RequiredScanStageMetadata;
};

export const SCAN_STAGE_METADATA = requireStageMetadata();

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
