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
	"repository-profile": "Repository Profile",
	"attack-surface-model": "Attack Surface Model",
	"identify-target": "Identify Target",
	"scan-target": "Scan Target",
	"analyze-finding": "Analyze Finding",
	"critique-finding": "Critique Finding",
	"verify-finding": "Verify Finding",
	"triage-finding": "Triage Finding",
	"repository-scan": "Scan Repository",
	repository: "Repository",
	"module-scan": "Scan Module",
	module: "Module",
	"module-threat-model": "Module Threat Model",
	"design-rule": "Design Rule",
	"scan-rule": "Scan Rule",
	"scan-pattern": "Scan Pattern",
	"sink-pre-analyze": "Sink Pre-Analyze",
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
	"repository profile": "repository-profile",
	"repository profiling": "repository-profile",
	"attack surface model": "attack-surface-model",
	"attack surface modeling": "attack-surface-model",
	"identify target": "identify-target",
	"target identification": "identify-target",
	"scan target": "scan-target",
	"target scanning": "scan-target",
	"analyze finding": "analyze-finding",
	"finding analysis": "analyze-finding",
	"critique finding": "critique-finding",
	"finding critique": "critique-finding",
	"verify finding": "verify-finding",
	"finding verification": "verify-finding",
	"triage finding": "triage-finding",
	"finding triage": "triage-finding",
	"scan repository": "repository-scan",
	"repository scanning": "repository-scan",
	"scan module": "module-scan",
	"module scanning": "module-scan",
	"module threat model": "module-threat-model",
	"module threat modeling": "module-threat-model",
	"design rule": "design-rule",
	"rule designing": "design-rule",
	"scan rule": "scan-rule",
	"rule scanning": "scan-rule",
	"scan pattern": "scan-pattern",
	"pattern scanning": "scan-pattern",
	"sink pre analyze": "sink-pre-analyze",
	"sink pre-analyze": "sink-pre-analyze",
	"sink pre analyzing": "sink-pre-analyze",
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
	failed: "Failed",
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
		: scanType === "rule"
			? scanT(t, "scan.scanType.rule", "Rule Scan")
		: scanT(t, "scan.scanType.full", "Vulnerability Mining");

export const formatResourceTypeLabel = (
	t: ScanTranslation,
	resourceType: "application" | "compose",
) =>
	resourceType === "application"
		? scanT(t, "scan.resource.application", "application")
		: scanT(t, "scan.resource.compose", "compose");
