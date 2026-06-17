import type { TFunction } from "i18next";

export type ScanTranslation = TFunction;

export const scanT = (
	t: ScanTranslation,
	key: string,
	defaultValue: string,
	values?: Record<string, string | number>,
) => String(t(key, { defaultValue, ...values }));

const normalizedKey = (value: string) => value.replace(/_/g, "-");

const titleCase = (value: string) =>
	value
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());

const STAGE_DEFAULTS: Record<string, string> = {
	"delta-scope": "Delta Scope",
	"repository-scan": "Scan Repository",
	repository: "Repository",
	"module-scan": "Scan Module",
	module: "Module",
	"function-scan": "Scan Function",
	function: "Function",
	analyze: "Analyze",
	criticize: "Criticize",
	"build-fuzzer": "Build Fuzzer",
	"run-fuzzer": "Run Fuzzer",
	verify: "Verify",
	triage: "Triage",
};

const STAGE_ALIASES: Record<string, string> = {
	"delta scoping": "delta-scope",
	"scan repository": "repository-scan",
	"repository scanning": "repository-scan",
	"scan module": "module-scan",
	"module scanning": "module-scan",
	"scan function": "function-scan",
	"function scanning": "function-scan",
	analyzing: "analyze",
	"build fuzzer": "build-fuzzer",
	"fuzz building": "build-fuzzer",
	"run fuzzer": "run-fuzzer",
	fuzzing: "run-fuzzer",
	criticizing: "criticize",
	verifying: "verify",
	triaging: "triage",
};

export const formatScanStageLabel = (
	t: ScanTranslation,
	stage?: string | null,
) => {
	if (!stage) {
		return "-";
	}
	const normalized = normalizedKey(stage.toLowerCase());
	const canonical = STAGE_ALIASES[stage.toLowerCase().replace(/[_-]/g, " ")] || normalized;
	return scanT(
		t,
		`scan.stage.${canonical}`,
		STAGE_DEFAULTS[canonical] || titleCase(stage),
	);
};

const TASK_STATUS_DEFAULTS: Record<string, string> = {
	pending: "Pending",
	queued: "Queued",
	launching: "Launching",
	launched: "Launched",
	starting: "Starting",
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	exited: "Exited",
	canceled: "Canceled",
	paused: "Paused",
	finished: "Finished",
};

export const formatScanStatusLabel = (
	t: ScanTranslation,
	status?: string | null,
) => {
	if (!status) {
		return "-";
	}
	const key = normalizedKey(status.toLowerCase());
	return scanT(t, `scan.status.${key}`, TASK_STATUS_DEFAULTS[key] || titleCase(status));
};

const SCAN_JOB_STATUS_DEFAULTS: Record<string, string> = {
	pending: "Pending",
	running: "Running",
	paused: "Paused",
	finished: "Finished",
	canceled: "Canceled",
};

export const formatScanJobStatusLabel = (
	t: ScanTranslation,
	status?: string | null,
) => {
	if (!status) {
		return "-";
	}
	const key = normalizedKey(status.toLowerCase());
	return scanT(
		t,
		`scan.jobStatus.${key}`,
		SCAN_JOB_STATUS_DEFAULTS[key] || titleCase(status),
	);
};

const ANALYSIS_RESULT_DEFAULTS: Record<string, string> = {
	real_vulnerability: "Real",
	likely_vulnerability: "Likely",
	plausible_but_unproven: "Plausible",
	false_positive: "False",
	api_misuse: "Misuse",
};

export const formatAnalysisResultLabel = (
	t: ScanTranslation,
	result?: string | null,
) => {
	if (!result) {
		return "-";
	}
	return scanT(
		t,
		`scan.analysisResult.${result}`,
		ANALYSIS_RESULT_DEFAULTS[result] || titleCase(result),
	);
};

const TRUTH_RESULT_DEFAULTS: Record<string, string> = {
	true: "True",
	likely: "Likely",
	false: "False",
};

export const formatTruthResultLabel = (
	t: ScanTranslation,
	result?: string | null,
) => {
	if (!result) {
		return "-";
	}
	return scanT(
		t,
		`scan.truthResult.${result}`,
		TRUTH_RESULT_DEFAULTS[result] || titleCase(result),
	);
};

export const formatScanTypeLabel = (
	t: ScanTranslation,
	scanType?: string | null,
) =>
	scanType === "delta"
		? scanT(t, "scan.scanType.delta", "Delta Scan")
		: scanT(t, "scan.scanType.full", "Full Scan");

export const formatResourceTypeLabel = (
	t: ScanTranslation,
	resourceType: "application" | "compose",
) =>
	resourceType === "application"
		? scanT(t, "scan.resource.application", "application")
		: scanT(t, "scan.resource.compose", "compose");
