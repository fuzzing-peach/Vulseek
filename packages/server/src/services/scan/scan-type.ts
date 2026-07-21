export const SCAN_TYPES = ["delta", "full", "research"] as const;

export type ScanType = (typeof SCAN_TYPES)[number];

export const getPipelineIdForScanType = (scanType: ScanType) => scanType;

export const getResearchMinimumDurationMs = () => {
	const configured = Number.parseInt(
		process.env.VULSEEK_RESEARCH_MIN_DURATION_MS || "10800000",
		10,
	);
	return Number.isFinite(configured) && configured > 0
		? configured
		: 3 * 60 * 60 * 1000;
};

export const usesFullRepositoryPreparation = (scanType: ScanType) =>
	scanType === "full" || scanType === "research";
