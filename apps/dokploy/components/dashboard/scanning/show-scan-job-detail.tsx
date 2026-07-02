import {
	AlertCircle,
	ChevronRight,
	ChevronsUpDown,
	Clipboard,
	ClipboardCheck,
	Download,
	FileIcon,
	FileSearch,
	Folder,
	Loader2,
	Pause,
	Play,
	RefreshCw,
	Search,
	SquareTerminal,
} from "lucide-react";
import Head from "next/head";
import { useTranslation } from "next-i18next";
import Link from "next/link";
import { useRouter } from "next/router";
import {
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	ANALYSIS_RESULT_OPTIONS,
	applyCandidateListQueryState,
	buildCandidateListStateHref,
	type CandidateSortDirection,
	type CandidateSortKey,
	parseCandidateListQueryState,
	serializeCandidateListQueryState,
	TRIAGE_RESULT_OPTIONS,
	VERIFY_RESULT_OPTIONS,
} from "@/components/dashboard/scanning/candidate-list-query-state";
import {
	LiveTaskActivityBadge,
	LiveTaskActivityButton,
	LiveTaskTextButton,
} from "@/components/dashboard/scanning/live-task-activity";
import { ScanMonitoring } from "@/components/dashboard/scanning/scan-monitoring";
import { ScanStageGraph } from "@/components/dashboard/scanning/scan-stage-graph";
import { useSandboxAgentActivities } from "@/components/dashboard/scanning/use-sandbox-agent-activity";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { idleSandboxAgentActivity } from "@/lib/scan/sandbox-agent-activity";
import { api, type RouterOutputs } from "@/utils/api";
import {
	formatAnalysisResultLabel,
	formatScanJobStatusLabel,
	formatScanStageLabel,
	formatScanStatusLabel,
	formatScanTypeLabel,
	formatTriageResultLabel,
	formatTruthResultLabel,
	scanT,
	type ScanTranslation,
} from "./scan-i18n";

interface Props {
	projectId: string;
	environmentId: string;
	serviceId: string;
	scanJobId: string;
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
}

type DirectoryListItem = {
	id: string;
	name: string;
	type: "file" | "directory";
	hasChildren?: boolean;
};

type DirectoryCacheEntry = {
	items: DirectoryListItem[];
	status: "idle" | "loading" | "loaded" | "error";
};

type ScanJobTab =
	| "overview"
	| "evaluate"
	| "tasks"
	| "candidates"
	| "monitoring"
	| "files";
type ScanResultSummary = RouterOutputs["scan"]["resultSummary"];
type ScanEvaluationResult = RouterOutputs["scan"]["latestEvaluation"];

const RESULT_SHORT_LABELS: Record<string, string> = {
	real_vulnerability: "Real",
	likely_vulnerability: "Likely",
	true: "True",
	likely: "Likely",
	false: "False",
	plausible_but_unproven: "Plausible",
	false_positive: "False",
	api_misuse: "Misuse",
};

const formatResultLabel = (value: string) =>
	value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const CANDIDATE_EXPORT_FIELDS = [
	{ key: "vulnerabilityCandidateId", label: "Candidate ID" },
	{ key: "scanJobId", label: "Scan Job ID" },
	{ key: "scanFunctionTaskId", label: "Function Task ID" },
	{ key: "title", label: "Title" },
	{ key: "description", label: "Description" },
	{ key: "fileHostPath", label: "Source File Host Path" },
	{ key: "line", label: "Line" },
	{ key: "vulnerabilityType", label: "Vulnerability Type" },
	{ key: "status", label: "Status" },
	{ key: "currentStage", label: "Current Stage" },
	{ key: "confidence", label: "Confidence" },
	{ key: "score", label: "Score" },
	{ key: "createdAt", label: "Created At" },
	{ key: "updatedAt", label: "Updated At" },
	{ key: "analysisTaskId", label: "Analysis Task ID" },
	{ key: "analysisResult", label: "Analysis Result" },
	{ key: "analysisConfidence", label: "Analysis Confidence" },
	{ key: "analysisScore", label: "Analysis Score" },
	{ key: "analysisSummary", label: "Analysis Summary" },
	{ key: "analysisReportHostPath", label: "Analysis Report Host Path" },
	{ key: "analysisRuntimeSeconds", label: "Analysis Runtime Seconds" },
	{ key: "analysisThreadId", label: "Analysis Thread ID" },
	{ key: "analysisCreatedAt", label: "Analysis Created At" },
	{ key: "analysisUpdatedAt", label: "Analysis Updated At" },
	{ key: "verificationTaskId", label: "Verification Task ID" },
	{ key: "verificationResult", label: "Verification Result" },
	{ key: "verificationConfidence", label: "Verification Confidence" },
	{ key: "verificationScore", label: "Verification Score" },
	{ key: "verificationSummary", label: "Verification Summary" },
	{ key: "verificationReportHostPath", label: "Verification Report Host Path" },
	{
		key: "verificationRuntimeSeconds",
		label: "Verification Runtime Seconds",
	},
	{ key: "verificationThreadId", label: "Verification Thread ID" },
	{ key: "verificationCreatedAt", label: "Verification Created At" },
	{ key: "verificationUpdatedAt", label: "Verification Updated At" },
	{ key: "triageTaskId", label: "Triage Task ID" },
	{ key: "triageResult", label: "Triage Result" },
	{ key: "triageDisqualifier", label: "Triage Disqualifier" },
	{ key: "triageDisqualifierReason", label: "Triage Disqualifier Reason" },
	{ key: "triageSecurityClassification", label: "Triage Classification" },
	{ key: "triageIsSecurityIssue", label: "Triage Is Security Issue" },
	{ key: "triageImpactType", label: "Triage Impact Type" },
	{ key: "triageCvssVector", label: "Triage CVSS Vector" },
	{ key: "triageCvssScore", label: "Triage CVSS Score" },
	{ key: "triageCvssSeverity", label: "Triage CVSS Severity" },
	{ key: "triageExploitability", label: "Triage Exploitability" },
	{ key: "triageIsExploitable", label: "Triage Is Exploitable" },
	{ key: "triageEpssProbability30d", label: "Triage EPSS 30d" },
	{ key: "triageEpssSource", label: "Triage EPSS Source" },
	{ key: "triageSummary", label: "Triage Summary" },
	{ key: "triageReportHostPath", label: "Triage Report Host Path" },
] as const;

type CandidateExportField = (typeof CANDIDATE_EXPORT_FIELDS)[number]["key"];

const DEFAULT_CANDIDATE_EXPORT_FIELDS = CANDIDATE_EXPORT_FIELDS.map(
	(field) => field.key,
);

const getCandidateExportFieldLabel = (
	t: ScanTranslation,
	field: (typeof CANDIDATE_EXPORT_FIELDS)[number],
) => scanT(t, `scan.exportField.${field.key}`, field.label);

const buildCandidateExportFilename = (scanJobId: string) => {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "")
		.replace("T", "-");
	return `scan-candidates-${scanJobId}-${timestamp}.json`;
};

const copyTextToClipboard = async (text: string) => {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "true");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	textarea.style.top = "0";
	document.body.appendChild(textarea);
	textarea.select();
	const didCopy = document.execCommand("copy");
	textarea.remove();
	if (!didCopy) {
		throw new Error("Failed to copy candidate JSON");
	}
};

const formatTaskRuntime = (
	startedAt: string | null | undefined,
	nowMs: number,
) => {
	if (!startedAt) {
		return "-";
	}
	const startedAtMs = new Date(startedAt).getTime();
	if (!Number.isFinite(startedAtMs)) {
		return "-";
	}
	const totalSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
};

const formatDurationSeconds = (value: number | null | undefined) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	const totalSeconds = Math.max(0, Math.floor(value));
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
};

const formatEvaluationMetric = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value)
		? value.toFixed(3)
		: "-";

const getEvaluationResult = (evaluation: ScanEvaluationResult) => {
	const result = evaluation?.result;
	return result && typeof result === "object" && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: null;
};

const formatTokenUsage = (t: ScanTranslation, value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return scanT(t, "scan.tokenUsage", "{{count}} tokens", {
		count: new Intl.NumberFormat().format(value),
	});
};

const formatTokenCount = (value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return new Intl.NumberFormat().format(value);
};

const formatTokenUsageWithCache = (
	t: ScanTranslation,
	total?: number | null,
	cached?: number | null,
) => {
	const totalValue = formatTokenCount(total);
	if (totalValue === "-") {
		return "-";
	}
	const cachedValue = formatTokenCount(cached);
	if (
		cachedValue === "-" ||
		typeof total !== "number" ||
		total <= 0 ||
		typeof cached !== "number" ||
		!Number.isFinite(cached)
	) {
		return scanT(t, "scan.tokenUsage", "{{count}} tokens", {
			count: totalValue,
		});
	}
	const cachedPercent = (cached / total) * 100;
	return scanT(
		t,
		"scan.cachedTokenUsage",
		"{{total}} / {{cached}} ({{percent}}% cached)",
		{
			total: totalValue,
			cached: cachedValue,
			percent: cachedPercent.toFixed(2),
		},
	);
};

const resolveRequestedTab = (
	value: string | string[] | undefined,
): ScanJobTab => {
	const rawTab =
		typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";
	if (
		rawTab === "overview" ||
		rawTab === "evaluate" ||
		rawTab === "tasks" ||
		rawTab === "candidates" ||
		rawTab === "monitoring" ||
		rawTab === "files"
	) {
		return rawTab;
	}
	if (rawTab === "stream") {
		return "tasks";
	}
	if (rawTab === "status" || rawTab === "analysis" || rawTab === "verify") {
		return "candidates";
	}
	return "overview";
};

const getShortResultLabel = (t: ScanTranslation, value?: string | null) => {
	if (!value) {
		return "-";
	}
	if (value in RESULT_SHORT_LABELS) {
		if (
			value === "real_vulnerability" ||
			value === "likely_vulnerability" ||
			value === "plausible_but_unproven" ||
			value === "false_positive" ||
			value === "api_misuse"
		) {
			return formatAnalysisResultLabel(t, value);
		}
		return formatTruthResultLabel(t, value);
	}
	if (
		value === "security_issue" ||
		value === "non_security" ||
		value === "hardening" ||
		value === "needs_review"
	) {
		return scanT(t, `scan.triageResult.${value}`, formatResultLabel(value));
	}
	return formatResultLabel(value);
};

const ROOT_DIRECTORY_KEY = "__root__";

type LazyFileTreeProps = {
	rootItems: DirectoryListItem[];
	rootStatus: DirectoryCacheEntry["status"];
	expandedDirectories: Record<string, boolean>;
	selectedFilePath: string | null;
	directoryCache: Record<string, DirectoryCacheEntry>;
	onToggleDirectory: (directoryPath: string) => void;
	onSelectFile: (filePath: string) => void;
};

const LazyFileTree = ({
	rootItems,
	rootStatus,
	expandedDirectories,
	selectedFilePath,
	directoryCache,
	onToggleDirectory,
	onSelectFile,
}: LazyFileTreeProps) => {
	const { t } = useTranslation("scan");
	const renderItems = (items: DirectoryListItem[], depth = 0): ReactNode =>
		items.map((item) => {
			const isDirectory = item.type === "directory";
			const isExpanded = !!expandedDirectories[item.id];
			const cacheEntry = directoryCache[item.id];
			const childStatus = cacheEntry?.status || "idle";
			const childItems = cacheEntry?.items || [];

			return (
				<div key={item.id}>
					<button
						type="button"
						onClick={() =>
							isDirectory ? onToggleDirectory(item.id) : onSelectFile(item.id)
						}
						className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
							!isDirectory && selectedFilePath === item.id
								? "bg-accent text-accent-foreground"
								: "hover:bg-muted/70"
						}`}
						style={{ paddingLeft: `${depth * 14 + 10}px` }}
					>
						{isDirectory ? (
							<ChevronRight
								className={`size-4 shrink-0 text-muted-foreground transition-transform ${
									isExpanded ? "rotate-90" : ""
								}`}
							/>
						) : (
							<span className="block size-4 shrink-0" />
						)}
						{isDirectory ? (
							<Folder className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<FileIcon className="size-4 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 truncate font-mono text-sm">
							{item.name}
						</span>
					</button>
					{isDirectory && isExpanded ? (
						<div>
							{childStatus === "loading" ? (
								<div
									className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									<Loader2 className="size-4 animate-spin" />
									{scanT(t, "scan.files.loadingShort", "Loading...")}
								</div>
							) : childStatus === "error" ? (
								<div
									className="px-2 py-1.5 text-sm text-destructive"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									{scanT(
										t,
										"scan.files.directoryLoadError",
										"Failed to load directory",
									)}
								</div>
							) : childStatus === "loaded" && childItems.length === 0 ? (
								<div
									className="px-2 py-1.5 text-sm text-muted-foreground"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									{scanT(t, "scan.files.emptyDirectory", "Empty")}
								</div>
							) : (
								renderItems(childItems, depth + 1)
							)}
						</div>
					) : null}
				</div>
			);
		});

	if (rootStatus === "loading") {
		return (
			<div className="flex h-full min-h-[320px] items-center justify-center gap-2 text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				{scanT(t, "scan.files.loading", "Loading files...")}
			</div>
		);
	}

	if (rootStatus === "error") {
		return (
			<div className="flex h-full min-h-[320px] items-center justify-center text-destructive">
				{scanT(t, "scan.files.loadError", "Failed to load files")}
			</div>
		);
	}

	if (rootItems.length === 0) {
		return (
			<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 text-muted-foreground">
				<Folder className="size-6" />
				{scanT(t, "scan.files.empty", "No files available")}
			</div>
		);
	}

	return (
		<div className="h-[65vh] overflow-auto p-2">{renderItems(rootItems)}</div>
	);
};

const getScanJobStatusLabel = (t: ScanTranslation, status?: string) =>
	formatScanJobStatusLabel(t, status || "pending");

const getScanJobStatusClassName = (status?: string) => {
	if (status === "finished") {
		return "text-green-600";
	}

	if (status === "canceled") {
		return "text-destructive";
	}

	if (status === "running") {
		return "text-amber-600";
	}

	if (status === "paused") {
		return "text-blue-600";
	}

	return "text-muted-foreground";
};

const formatTriggerSourceLabel = (
	t: ScanTranslation,
	triggerSource?: string,
) =>
	triggerSource === "schedule"
		? scanT(t, "scan.jobs.auto", "auto")
		: triggerSource === "manual" || !triggerSource
			? scanT(t, "scan.jobs.manual", "manual")
			: triggerSource;

const getAnalysisResultBadgeClassName = (result?: string | null) => {
	if (result === "real_vulnerability") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}

	if (result === "likely_vulnerability") {
		return "border-orange-200 bg-orange-100 text-orange-700 dark:border-orange-500/60 dark:bg-orange-950/50 dark:text-orange-100";
	}

	if (result === "plausible_but_unproven") {
		return "border-yellow-200 bg-yellow-100 text-yellow-700 dark:border-yellow-500/60 dark:bg-yellow-950/50 dark:text-yellow-100";
	}

	if (result === "false_positive") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}

	if (result === "api_misuse") {
		return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-500/60 dark:bg-slate-900/70 dark:text-slate-100";
	}

	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const getVerificationTruthBadge = (
	t: ScanTranslation,
	result?: string | null,
): { label: string; className: string } | null => {
	if (!result) {
		return null;
	}

	if (result === "true") {
		return {
			label: formatTruthResultLabel(t, "true"),
			className:
				"border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100",
		};
	}

	if (result === "likely") {
		return {
			label: formatTruthResultLabel(t, "likely"),
			className:
				"border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100",
		};
	}

	return {
		label: getShortResultLabel(t, result),
		className: "border-muted-foreground/20 bg-muted text-muted-foreground",
	};
};

const getTriageResultBadgeClassName = (result?: string | null) => {
	if (result === "security_issue") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}

	if (result === "non_security") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}

	if (result === "needs_more_information") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}

	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const getTaskStageLabel = (t: ScanTranslation, stage?: string) => {
	if (
		stage === "Delta Scope" ||
		stage === "delta-scope" ||
		stage === "delta_scoping"
	) {
		return formatScanStageLabel(t, "delta-scope");
	}
	if (
		stage === "Scan Repository" ||
		stage === "repository_scanning"
	) {
		return formatScanStageLabel(t, "repository-profile");
	}
	if (stage === "repository-scan") {
		return formatScanStageLabel(t, "repository-scan");
	}
	if (
		stage === "Attack Surface Model" ||
		stage === "attack-surface-model" ||
		stage === "attack_surface_modeling"
	) {
		return formatScanStageLabel(t, "attack-surface-model");
	}
	if (
		stage === "Scan Module" ||
		stage === "module_scanning"
	) {
		return formatScanStageLabel(t, "identify-target");
	}
	if (stage === "module-scan") {
		return formatScanStageLabel(t, "module-scan");
	}
	if (
		stage === "Module Threat Model" ||
		stage === "module-threat-model" ||
		stage === "module_threat_modeling"
	) {
		return formatScanStageLabel(t, "module-threat-model");
	}
	if (
		stage === "Design Rule" ||
		stage === "design-rule" ||
		stage === "rule_designing"
	) {
		return formatScanStageLabel(t, "design-rule");
	}
	if (
		stage === "Scan Rule" ||
		stage === "scan-rule" ||
		stage === "rule_scanning"
	) {
		return formatScanStageLabel(t, "scan-rule");
	}
	if (
		stage === "Scan Pattern" ||
		stage === "scan-pattern" ||
		stage === "pattern_scanning"
	) {
		return formatScanStageLabel(t, "scan-pattern");
	}
	if (
		stage === "Sink Pre-Analyze" ||
		stage === "sink-pre-analyze" ||
		stage === "sink_pre_analyzing"
	) {
		return formatScanStageLabel(t, "sink-pre-analyze");
	}
	if (
		stage === "Scan Function" ||
		stage === "function_scanning"
	) {
		return formatScanStageLabel(t, "scan-target");
	}
	if (stage === "function-scan") {
		return formatScanStageLabel(t, "function-scan");
	}
	if (stage === "Analyze" || stage === "analyze" || stage === "analyzing") {
		return formatScanStageLabel(t, "analyze-finding");
	}
	if (
		stage === "Build Fuzzer" ||
		stage === "build-fuzzer" ||
		stage === "fuzz_building"
	) {
		return formatScanStageLabel(t, "build-fuzzer");
	}
	if (stage === "Run Fuzzer" || stage === "run-fuzzer" || stage === "fuzzing") {
		return formatScanStageLabel(t, "run-fuzzer");
	}
	if (
		stage === "Criticize" ||
		stage === "criticize" ||
		stage === "criticizing"
	) {
		return formatScanStageLabel(t, "critique-finding");
	}
	if (stage === "Verify" || stage === "verify" || stage === "verifying") {
		return formatScanStageLabel(t, "verify-finding");
	}
	if (stage === "Triage" || stage === "triage" || stage === "triaging") {
		return formatScanStageLabel(t, "triage-finding");
	}
	return formatScanStageLabel(t, stage);
};

const RERUNNABLE_CANDIDATE_STATUSES = new Set(["completed", "failed", "exited"]);
const RERUNNABLE_TASK_STATUSES = new Set(["completed", "failed", "exited", "canceled"]);

const buildCandidateReanalysisKey = (input: {
	vulnerabilityCandidateId: string;
	scanFunctionTaskId?: string | null;
}) => `${input.scanFunctionTaskId || "default"}:${input.vulnerabilityCandidateId}`;

const getTaskStatusLabel = (t: ScanTranslation, status?: string) => {
	if (!status) {
		return "-";
	}
	return formatScanStatusLabel(t, status);
};

const getTaskStatusBadgeClassName = (status?: string) => {
	if (status === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100";
	}
	if (status === "failed") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}
	if (status === "canceled") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	if (status === "running" || status === "starting") {
		return "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/50 dark:text-sky-100";
	}
	if (status === "launching" || status === "launched") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const localizeTaskListText = (
	t: ScanTranslation,
	value?: string | null,
): string => {
	const text = (value || "").trim();
	if (!text || text === "-") {
		return "";
	}
	if (text === "Delta Scope") {
		return formatScanStageLabel(t, "delta-scope");
	}
	if (text === "Repository Scanner") {
		return formatScanStageLabel(t, "repository-profile");
	}
	if (text === "Diff impact function scoping") {
		return scanT(
			t,
			"scan.tasks.deltaScopeSubtitle",
			"增量 diff 影响函数定位",
		);
	}
	if (text === "Repository-wide planner and module partitioning") {
		return scanT(
			t,
			"scan.tasks.repositoryScannerSubtitle",
			"仓库级规划和模块拆分",
		);
	}
	return text;
};

const getTaskListDisplay = (
	t: ScanTranslation,
	task: { title: string; subtitle?: string | null; stage?: string | null },
) => {
	const title = getTaskStageLabel(t, task.stage || undefined);
	const localizedTitle = localizeTaskListText(t, task.title);
	const localizedSubtitle = localizeTaskListText(t, task.subtitle);
	const subtitleParts = [localizedSubtitle, localizedTitle]
		.filter((value) => value && value !== "-" && value !== title);
	return {
		title,
		subtitle: subtitleParts.join(" · ") || "-",
	};
};

const RUNNING_TASK_STAGE_ORDER: Record<string, number> = {
	delta_scoping: 0,
	repository_scanning: 1,
	attack_surface_modeling: 2,
	module_scanning: 3,
	module_threat_modeling: 4,
	rule_designing: 5,
	rule_scanning: 6,
	pattern_scanning: 7,
	sink_pre_analyzing: 8,
	function_scanning: 9,
	analyzing: 10,
	fuzz_building: 11,
	fuzzing: 12,
	criticizing: 13,
	verifying: 14,
	triaging: 15,
};

const TASK_STAGE_OPTION_BY_STAGE_NAME: Record<string, string> = {
	"delta-scope": "delta_scoping",
	"repository-profile": "repository_scanning",
	"repository-scan": "repository_scanning",
	"attack-surface-model": "attack_surface_modeling",
	"identify-target": "module_scanning",
	"module-scan": "module_scanning",
	"module-threat-model": "module_threat_modeling",
	"design-rule": "rule_designing",
	"scan-rule": "rule_scanning",
	"scan-pattern": "pattern_scanning",
	"sink-pre-analyze": "sink_pre_analyzing",
	"scan-target": "function_scanning",
	"function-scan": "function_scanning",
	"analyze-finding": "analyzing",
	analyze: "analyzing",
	"build-fuzzer": "fuzz_building",
	"run-fuzzer": "fuzzing",
	"critique-finding": "criticizing",
	criticize: "criticizing",
	"verify-finding": "verifying",
	verify: "verifying",
	"triage-finding": "triaging",
	triage: "triaging",
};

const normalizeTaskStageOption = (stage?: string | null) => {
	if (!stage) {
		return null;
	}
	return TASK_STAGE_OPTION_BY_STAGE_NAME[stage] ||
		(stage in RUNNING_TASK_STAGE_ORDER ? stage : null);
};

const TERMINAL_TASK_STATUS_OPTIONS = [
	"completed",
	"failed",
	"exited",
	"canceled",
];
const TASK_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const formatSummaryCount = (value?: number | null) =>
	new Intl.NumberFormat().format(value ?? 0);

const RESULT_FLOW_LAYOUT: Record<
	string,
	{
		x: number;
		y: number;
		width: number;
		height: number;
		className: string;
	}
> = {
	analysis_real: {
		x: 24,
		y: 86,
		width: 154,
		height: 54,
		className:
			"fill-red-50 stroke-red-300 dark:fill-red-950/40 dark:stroke-red-500/70",
	},
	analysis_likely: {
		x: 24,
		y: 190,
		width: 154,
		height: 54,
		className:
			"fill-orange-50 stroke-orange-300 dark:fill-orange-950/40 dark:stroke-orange-500/70",
	},
	verify_true: {
		x: 280,
		y: 24,
		width: 154,
		height: 54,
		className:
			"fill-emerald-50 stroke-emerald-300 dark:fill-emerald-950/40 dark:stroke-emerald-500/70",
	},
	verify_likely: {
		x: 280,
		y: 92,
		width: 154,
		height: 54,
		className:
			"fill-orange-50 stroke-orange-300 dark:fill-orange-950/40 dark:stroke-orange-500/70",
	},
	verify_false: {
		x: 280,
		y: 160,
		width: 154,
		height: 54,
		className:
			"fill-slate-50 stroke-slate-300 dark:fill-slate-950/40 dark:stroke-slate-500/70",
	},
	verify_missing: {
		x: 280,
		y: 228,
		width: 154,
		height: 54,
		className:
			"fill-amber-50 stroke-amber-300 dark:fill-amber-950/40 dark:stroke-amber-500/70",
	},
	triage_security_issue: {
		x: 536,
		y: 58,
		width: 154,
		height: 54,
		className:
			"fill-red-50 stroke-red-300 dark:fill-red-950/40 dark:stroke-red-500/70",
	},
	triage_not_security: {
		x: 536,
		y: 142,
		width: 154,
		height: 54,
		className:
			"fill-slate-50 stroke-slate-300 dark:fill-slate-950/40 dark:stroke-slate-500/70",
	},
	triage_missing: {
		x: 536,
		y: 226,
		width: 154,
		height: 54,
		className:
			"fill-amber-50 stroke-amber-300 dark:fill-amber-950/40 dark:stroke-amber-500/70",
	},
};

const getResultFlowStrokeClassName = (target: string) => {
	if (target === "verify_true" || target === "triage_security_issue") {
		return "stroke-emerald-500";
	}
	if (target === "verify_likely") {
		return "stroke-orange-400";
	}
	if (target === "verify_false" || target === "triage_not_security") {
		return "stroke-slate-400";
	}
	return "stroke-amber-400";
};

const getResultFlowCardClassName = (id: string) => {
	if (id === "analysis_real") {
		return "border-red-200 bg-red-50 dark:border-red-500/60 dark:bg-red-950/30";
	}
	if (id === "analysis_likely") {
		return "border-orange-200 bg-orange-50 dark:border-orange-500/60 dark:bg-orange-950/30";
	}
	if (id === "verify_true") {
		return "border-emerald-200 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-950/30";
	}
	if (id === "verify_likely") {
		return "border-orange-200 bg-orange-50 dark:border-orange-500/60 dark:bg-orange-950/30";
	}
	if (id === "triage_security_issue") {
		return "border-red-200 bg-red-50 dark:border-red-500/60 dark:bg-red-950/30";
	}
	if (id === "verify_missing" || id === "triage_missing") {
		return "border-amber-200 bg-amber-50 dark:border-amber-500/60 dark:bg-amber-950/30";
	}
	return "border-muted bg-muted/30";
};

const getResultFlowNodeLabel = (
	t: ScanTranslation,
	id: string,
	fallback: string,
) => {
	switch (id) {
		case "analysis_real":
			return scanT(
				t,
				"scan.results.flow.node.analysisReal",
				"Analysis Real",
			);
		case "analysis_likely":
			return scanT(
				t,
				"scan.results.flow.node.analysisLikely",
				"Analysis Likely",
			);
		case "verify_true":
			return scanT(
				t,
				"scan.results.flow.node.verifyTrue",
				"Verify True",
			);
		case "verify_likely":
			return scanT(
				t,
				"scan.results.flow.node.verifyLikely",
				"Verify Likely",
			);
		case "verify_false":
			return scanT(t, "scan.results.flow.node.verifyFalse", "Verify False");
		case "verify_missing":
			return scanT(
				t,
				"scan.results.flow.node.verifyMissing",
				"Wait Verifying",
			);
		case "triage_security_issue":
			return scanT(t, "scan.results.flow.node.triageTrue", "Triage True");
		case "triage_not_security":
			return scanT(t, "scan.results.flow.node.triageFalse", "Triage False");
		case "triage_missing":
			return scanT(
				t,
				"scan.results.flow.node.triageMissing",
				"Wait Triage",
			);
		default:
			return fallback;
	}
};

const ResultFlowChart = ({
	summary,
	t,
}: {
	summary?: ScanResultSummary | null;
	t: ScanTranslation;
}) => {
	const nodes = summary?.flow.nodes ?? [];
	const links = summary?.flow.links ?? [];
	const maxLinkCount = Math.max(1, ...links.map((link) => link.count));
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const positiveCount = summary?.counts.analysisPositive ?? 0;

	if (!summary || positiveCount === 0) {
		return (
			<div className="flex h-44 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
				{scanT(
					t,
					"scan.results.flow.empty",
					"No positive analysis results to visualize.",
				)}
			</div>
		);
	}

	return (
		<>
			<div className="grid gap-3 md:hidden">
				{nodes
					.filter(
						(node) => node.id === "analysis_real" || node.id === "analysis_likely",
					)
					.map((node) => (
						<div
							key={node.id}
							className={`rounded-lg border p-3 ${getResultFlowCardClassName(
								node.id,
							)}`}
						>
							<div className="text-sm font-medium">
								{getResultFlowNodeLabel(t, node.id, node.label)}
							</div>
							<div className="mt-1 text-2xl font-semibold tabular-nums">
								{formatSummaryCount(node.count)}
							</div>
						</div>
					))}
				<div className="grid gap-2">
					<div className="text-xs font-medium uppercase text-muted-foreground">
						{scanT(t, "scan.results.flow.column.verify", "Verify")}
					</div>
					{links
						.filter((link) => link.source.startsWith("analysis_"))
						.map((link) => {
							const target = nodeById.get(link.target);
							const source = nodeById.get(link.source);
							return (
								<div
									key={`${link.source}-${link.target}`}
									className={`rounded-lg border p-3 ${getResultFlowCardClassName(
										link.target,
									)}`}
								>
									<div className="flex items-center justify-between gap-3">
										<div className="min-w-0 text-sm font-medium">
											{getResultFlowNodeLabel(
												t,
												link.target,
												target?.label ?? link.target,
											)}
										</div>
										<div className="shrink-0 text-lg font-semibold tabular-nums">
											{formatSummaryCount(link.count)}
										</div>
									</div>
									<div className="mt-1 text-xs text-muted-foreground">
										{scanT(t, "scan.results.flow.from", "from")}{" "}
										{getResultFlowNodeLabel(
											t,
											link.source,
											source?.label ?? link.source,
										)}
									</div>
								</div>
							);
						})}
				</div>
				<div className="grid gap-2">
					<div className="text-xs font-medium uppercase text-muted-foreground">
						{scanT(t, "scan.results.flow.column.triage", "Triage")}
					</div>
					{links
						.filter((link) => link.source.startsWith("verify_"))
						.map((link) => {
							const source = nodeById.get(link.source);
							const target = nodeById.get(link.target);
							return (
								<div
									key={`${link.source}-${link.target}`}
									className={`rounded-lg border p-3 ${getResultFlowCardClassName(
										link.target,
									)}`}
								>
									<div className="flex items-center justify-between gap-3">
										<div className="min-w-0 text-sm font-medium">
											{getResultFlowNodeLabel(
												t,
												link.target,
												target?.label ?? link.target,
											)}
										</div>
										<div className="shrink-0 text-lg font-semibold tabular-nums">
											{formatSummaryCount(link.count)}
										</div>
									</div>
									<div className="mt-1 text-xs text-muted-foreground">
										{scanT(t, "scan.results.flow.from", "from")}{" "}
										{getResultFlowNodeLabel(
											t,
											link.source,
											source?.label ?? link.source,
										)}
									</div>
								</div>
							);
						})}
				</div>
			</div>
			<div className="hidden w-full overflow-hidden md:block">
			<svg
				viewBox="0 0 714 330"
				className="h-[330px] min-w-[714px] w-full"
				role="img"
				aria-label={scanT(
					t,
					"scan.results.flow.ariaLabel",
					"Candidate result flow from analysis to verification and triage",
				)}
			>
				<title>{scanT(t, "scan.results.flow.svgTitle", "Candidate result flow")}</title>
				{links.map((link) => {
					const source = RESULT_FLOW_LAYOUT[link.source];
					const target = RESULT_FLOW_LAYOUT[link.target];
					if (!source || !target) {
						return null;
					}
					const sourceX = source.x + source.width;
					const sourceY = source.y + source.height / 2;
					const targetX = target.x;
					const targetY = target.y + target.height / 2;
					const strokeWidth = Math.max(
						2,
						Math.round((link.count / maxLinkCount) * 26),
					);
					return (
						<path
							key={`${link.source}-${link.target}`}
							d={`M ${sourceX} ${sourceY} C ${sourceX + 70} ${sourceY}, ${
								targetX - 70
							} ${targetY}, ${targetX} ${targetY}`}
							className={`${getResultFlowStrokeClassName(link.target)} opacity-30`}
							fill="none"
							strokeWidth={strokeWidth}
							strokeLinecap="round"
						/>
					);
				})}
				{nodes.map((node) => {
					const layout = RESULT_FLOW_LAYOUT[node.id];
					if (!layout) {
						return null;
					}
					return (
						<g key={node.id}>
							<rect
								x={layout.x}
								y={layout.y}
								width={layout.width}
								height={layout.height}
								rx="8"
								className={layout.className}
							/>
							<text
								x={layout.x + 14}
								y={layout.y + 24}
								className="fill-foreground text-[13px] font-medium"
							>
								{getResultFlowNodeLabel(
									t,
									node.id,
									nodeById.get(node.id)?.label ?? node.label,
								)}
							</text>
							<text
								x={layout.x + 14}
								y={layout.y + 46}
								className="fill-muted-foreground text-[18px] font-semibold"
							>
								{formatSummaryCount(node.count)}
							</text>
						</g>
					);
				})}
				<text x="24" y="14" className="fill-muted-foreground text-[11px]">
					{scanT(t, "scan.results.flow.column.analysis", "Analysis")}
				</text>
				<text x="280" y="14" className="fill-muted-foreground text-[11px]">
					{scanT(t, "scan.results.flow.column.verify", "Verify")}
				</text>
				<text x="536" y="14" className="fill-muted-foreground text-[11px]">
					{scanT(t, "scan.results.flow.column.triage", "Triage")}
				</text>
			</svg>
			</div>
		</>
	);
};

const RunningCapacityBars = ({
	running,
	limit,
}: {
	running: number;
	limit: number;
}) => {
	const blockCount = Math.max(1, limit, running);
	return (
		<div className="flex items-center justify-end gap-2">
			<div className="flex min-h-3 items-center gap-1">
				{Array.from({ length: blockCount }, (_, index) => (
					<span
						key={index}
						className={`h-3 w-1 rounded-[1px] shadow-[0_0_0_1px_hsl(var(--background))] ${
							index < running ? "bg-sky-500" : "bg-muted-foreground/20"
						}`}
					/>
				))}
			</div>
			<span className="min-w-12 text-right tabular-nums">
				{running} / {Math.max(1, limit)}
			</span>
		</div>
	);
};

export const ShowScanJobDetail = ({
	projectId,
	environmentId,
	serviceId,
	scanJobId,
	serviceType,
	routeSegment,
}: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const utils = api.useUtils();
	const initialCandidateListQueryState = parseCandidateListQueryState(
		router.query,
	);
	const [activeTab, setActiveTab] = useState<ScanJobTab>(() =>
		resolveRequestedTab(router.query.tab),
	);
	const [candidateQuery, setCandidateQuery] = useState(
		() => initialCandidateListQueryState.candidateQuery,
	);
	const [analysisFilters, setAnalysisFilters] = useState<string[]>(
		() => initialCandidateListQueryState.analysisFilters,
	);
	const [verifyFilters, setVerifyFilters] = useState<string[]>(
		() => initialCandidateListQueryState.verifyFilters,
	);
	const [triageFilters, setTriageFilters] = useState<string[]>(
		() => initialCandidateListQueryState.triageFilters,
	);
	const [candidateSortKey, setCandidateSortKey] = useState<CandidateSortKey>(
		() => initialCandidateListQueryState.candidateSortKey,
	);
	const [candidateSortDirection, setCandidateSortDirection] =
		useState<CandidateSortDirection>(
			() => initialCandidateListQueryState.candidateSortDirection,
		);
	const [candidatePage, setCandidatePage] = useState(
		() => initialCandidateListQueryState.candidatePage,
	);
	const [candidatePageSize, setCandidatePageSize] = useState(
		() => initialCandidateListQueryState.candidatePageSize,
	);
	const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [selectedFinishedTaskIds, setSelectedFinishedTaskIds] = useState<
		Set<string>
	>(() => new Set());
	const [isCandidateExportDialogOpen, setIsCandidateExportDialogOpen] =
		useState(false);
	const [isEvaluateDialogOpen, setIsEvaluateDialogOpen] = useState(false);
	const [evaluateAgentProfileIdDraft, setEvaluateAgentProfileIdDraft] =
		useState("");
	const [evaluateGroundTruthPathDraft, setEvaluateGroundTruthPathDraft] =
		useState("");
	const [candidateExportFields, setCandidateExportFields] = useState<
		CandidateExportField[]
	>(() => [...DEFAULT_CANDIDATE_EXPORT_FIELDS]);
	const [taskSearchQuery, setTaskSearchQuery] = useState("");
	const [runningTaskStageFilter, setRunningTaskStageFilter] = useState("all");
	const [finishedTaskStageFilter, setFinishedTaskStageFilter] = useState("all");
	const [taskStatusFilter, setTaskStatusFilter] = useState("all");
	const [runningTaskPage, setRunningTaskPage] = useState(1);
	const [runningTaskPageSize, setRunningTaskPageSize] = useState(10);
	const [finishedTaskPage, setFinishedTaskPage] = useState(1);
	const [finishedTaskPageSize, setFinishedTaskPageSize] = useState(20);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [noteDraft, setNoteDraft] = useState("");
	const [expandedDirectories, setExpandedDirectories] = useState<
		Record<string, boolean>
	>({});
	const [directoryCache, setDirectoryCache] = useState<
		Record<string, DirectoryCacheEntry>
	>({});
	const [runtimeNowMs, setRuntimeNowMs] = useState(() => Date.now());
	const restoredCandidateScrollKeyRef = useRef<string | null>(null);
	const isApplyingQueryStateRef = useRef(false);

	const serviceQuery =
		serviceType === "application"
			? api.application.one.useQuery({ applicationId: serviceId })
			: api.compose.one.useQuery({ composeId: serviceId });
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery(undefined, {
		enabled: serviceType === "application",
	});
	const enabledAgentProfiles =
		agentProfiles?.filter((profile) => profile.isEnabled) ?? [];
	const serviceData = serviceQuery.data;
	const applicationEvaluateConfig =
		serviceType === "application" &&
		serviceData &&
		"evaluateConfig" in serviceData
			? serviceData.evaluateConfig
			: { agentProfileId: "", groundTruthPath: "" };

	const { data: scanJob, isLoading: isLoadingJob } = api.scan.one.useQuery(
		{ scanJobId },
		{ enabled: !!scanJobId, refetchInterval: 1000 },
	);
	const shouldLoadStatusView =
		activeTab === "overview" || activeTab === "tasks";
	const shouldLoadJobActivities = activeTab === "tasks";
	const { data: candidates, isLoading: isLoadingCandidates } =
		api.scan.candidates.useQuery(
			{
				scanJobId,
				page: candidatePage,
				pageSize: candidatePageSize,
				query: candidateQuery,
				analysisResults: analysisFilters.join(","),
				verifyResults: verifyFilters.join(","),
				triageResults: triageFilters.join(","),
				sortKey: candidateSortKey,
				sortDirection: candidateSortDirection,
			},
			{
				enabled: !!scanJobId && activeTab === "candidates",
				refetchInterval: activeTab === "candidates" ? 1000 : false,
				keepPreviousData: true,
			},
		);
	const { data: statusView, error: statusViewError } =
		api.scan.statusView.useQuery(
			{ scanJobId },
			{
				enabled: !!scanJobId && shouldLoadStatusView,
				refetchInterval: shouldLoadStatusView ? 1000 : false,
			},
		);
	const { data: resultSummary, isLoading: isLoadingResultSummary } =
		api.scan.resultSummary.useQuery(
			{ scanJobId },
			{
				enabled: !!scanJobId && activeTab === "overview",
				refetchInterval: activeTab === "overview" ? 2000 : false,
			},
		);
	const { data: latestEvaluation, isLoading: isLoadingLatestEvaluation } =
		api.scan.latestEvaluation.useQuery(
				{ scanJobId },
				{
					enabled:
						!!scanJobId && activeTab === "evaluate" && serviceType === "application",
					refetchInterval: activeTab === "evaluate" ? 2000 : false,
				},
			);
	const { data: terminalTasks, isLoading: isLoadingTerminalTasks } =
		api.scan.terminalTasks.useQuery(
			{
				scanJobId,
				page: finishedTaskPage,
				pageSize: finishedTaskPageSize,
				query: taskSearchQuery,
				stage: finishedTaskStageFilter,
				status: taskStatusFilter,
			},
			{
				enabled: !!scanJobId && activeTab === "tasks",
				refetchInterval: activeTab === "tasks" ? 1000 : false,
				keepPreviousData: true,
			},
		);
	const { activitiesByTaskId, connectedTaskIds: activityConnectedTaskIds } =
		useSandboxAgentActivities({
			scanJobId,
			enabled: !!scanJobId && shouldLoadJobActivities,
		});
	const { data: selectedFile, isLoading: isLoadingSelectedFile } =
		api.scan.readFile.useQuery(
			{ scanJobId, filePath: selectedFilePath || "" },
			{ enabled: !!scanJobId && !!selectedFilePath },
		);
	const rerunTaskMutation = api.scan.rerunTask.useMutation();
	const cancelScanJobMutation = api.scan.cancel.useMutation();
	const pauseScanJobMutation = api.scan.pause.useMutation();
	const resumeScanJobMutation = api.scan.resume.useMutation();
	const updateNoteMutation = api.scan.updateNote.useMutation();
	const analyzeCandidateMutation = api.scan.analyzeCandidate.useMutation();
	const startCandidateReviewContainerMutation =
		api.scan.startCandidateReviewContainer.useMutation();
	const startEvaluationMutation = api.scan.startEvaluation.useMutation();
	const [reanalyzingCandidateId, setReanalyzingCandidateId] = useState<
		string | null
	>(null);
	const [rerunningTaskId, setRerunningTaskId] = useState<string | null>(null);
	const [bulkRerunningTaskIds, setBulkRerunningTaskIds] = useState<Set<string>>(
		() => new Set(),
	);
	const rootDirectoryQuery = api.scan.listDirectory.useQuery(
		{ scanJobId },
		{
			enabled: !!scanJobId && activeTab === "files",
			refetchInterval: activeTab === "files" ? 4000 : false,
		},
	);

	useEffect(() => {
		setSelectedFilePath(null);
		setExpandedDirectories({});
		setDirectoryCache({});
	}, [scanJobId]);

	useEffect(() => {
		setNoteDraft(scanJob?.note ?? "");
	}, [scanJob?.note]);

	const requestedTab = useMemo(
		() => resolveRequestedTab(router.query.tab),
		[router.query.tab],
	);

	const isNoteDirty = (scanJob?.note ?? "") !== noteDraft;
	const canPauseScanJob =
		scanJob?.status === "pending" || scanJob?.status === "running";
	const canResumeScanJob = scanJob?.status === "paused";
	const canCancelScanJob =
		scanJob?.status === "pending" ||
		scanJob?.status === "running" ||
		scanJob?.status === "paused";
	const canEvaluateScanJob =
		serviceType === "application" && Boolean(scanJob?.applicationId);
	const refreshScanJobViews = async () => {
		await Promise.all([
			utils.scan.one.invalidate({ scanJobId }),
			utils.scan.statusView.invalidate({ scanJobId }),
			utils.scan.resultSummary.invalidate({ scanJobId }),
			utils.scan.latestEvaluation.invalidate({ scanJobId }),
			utils.scan.candidates.invalidate({ scanJobId }),
			serviceType === "application"
				? utils.scan.allByApplication.invalidate({
						applicationId: serviceId,
					})
				: utils.scan.allByCompose.invalidate({
						composeId: serviceId,
					}),
		]);
	};

	const candidateListQueryState = useMemo(
		() => parseCandidateListQueryState(router.query),
		[router.query],
	);
	const candidateListQueryStateSerialized = useMemo(
		() => serializeCandidateListQueryState(candidateListQueryState),
		[candidateListQueryState],
	);
	const currentCandidateListState = useMemo(
		() => ({
			candidateQuery,
			analysisFilters,
			verifyFilters,
			triageFilters,
			candidateSortKey,
			candidateSortDirection,
			candidatePage,
			candidatePageSize,
		}),
		[
			analysisFilters,
			candidateQuery,
			candidatePage,
			candidatePageSize,
			candidateSortDirection,
			candidateSortKey,
			triageFilters,
			verifyFilters,
		],
	);
	const currentCandidateListStateSerialized = useMemo(
		() => serializeCandidateListQueryState(currentCandidateListState),
		[currentCandidateListState],
	);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		isApplyingQueryStateRef.current = true;
		setActiveTab(requestedTab);
		setCandidateQuery(candidateListQueryState.candidateQuery);
		setAnalysisFilters(candidateListQueryState.analysisFilters);
		setVerifyFilters(candidateListQueryState.verifyFilters);
		setTriageFilters(candidateListQueryState.triageFilters);
		setCandidateSortKey(candidateListQueryState.candidateSortKey);
		setCandidateSortDirection(candidateListQueryState.candidateSortDirection);
		setCandidatePage(candidateListQueryState.candidatePage);
		setCandidatePageSize(candidateListQueryState.candidatePageSize);
	}, [
		requestedTab,
		router.isReady,
		candidateListQueryStateSerialized,
		candidateListQueryState,
	]);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		const hasCaughtUp =
			activeTab === requestedTab &&
			currentCandidateListStateSerialized === candidateListQueryStateSerialized;
		if (hasCaughtUp) {
			isApplyingQueryStateRef.current = false;
		}
	}, [
		activeTab,
		requestedTab,
		router.isReady,
		currentCandidateListStateSerialized,
		candidateListQueryStateSerialized,
	]);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		if (isApplyingQueryStateRef.current) {
			return;
		}

		if (
			currentCandidateListStateSerialized === candidateListQueryStateSerialized
		) {
			return;
		}

		void router.replace(
			{
				pathname: router.pathname,
				query: applyCandidateListQueryState(
					router.query,
					currentCandidateListState,
					activeTab,
				),
			},
			undefined,
			{ shallow: true },
		);
	}, [
		activeTab,
		candidateListQueryStateSerialized,
		currentCandidateListState,
		currentCandidateListStateSerialized,
		router,
	]);
	const queuePendingCounts = statusView?.queuePendingCounts ?? [];
	const getQueueTaskMetrics = (queue: (typeof queuePendingCounts)[number]) => {
		const queued =
			(queue.queuedCount ?? queue.pendingCount ?? 0) +
			(queue.launchingCount ?? 0) +
			(queue.launchedCount ?? 0);
		const running = (queue.runningCount ?? 0) + (queue.startingCount ?? 0);
		const done = queue.completedCount + (queue.exitedCount ?? 0);
		const concurrencyLimit = Math.max(
			1,
			Number(
				(queue as { concurrencyLimit?: number | null }).concurrencyLimit ?? 1,
			) || 1,
		);
		return {
			queued,
			running,
			done,
			concurrencyLimit,
			title: scanT(
				t,
				"scan.tasks.queueMetrics",
				"排队 {{queued}}，运行 {{running}} / {{limit}}，完成 {{done}}",
				{ queued, running, limit: concurrencyLimit, done },
			),
		};
	};
	const sortedInProgressTasks = useMemo(() => {
		return [...(statusView?.inProgressTasks || [])].sort((left, right) => {
			const stageRankDiff =
				(RUNNING_TASK_STAGE_ORDER[left.stage] ?? Number.MAX_SAFE_INTEGER) -
				(RUNNING_TASK_STAGE_ORDER[right.stage] ?? Number.MAX_SAFE_INTEGER);
			if (stageRankDiff !== 0) {
				return stageRankDiff;
			}
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	}, [statusView?.inProgressTasks]);
	const taskStageOptions = useMemo(() => {
		const seen = new Set<string>();
		const addStage = (stage?: string | null) => {
			const option = normalizeTaskStageOption(stage);
			if (option) {
				seen.add(option);
			}
		};

		for (const queue of queuePendingCounts) {
			addStage(queue.stageName);
		}
		for (const task of sortedInProgressTasks) {
			addStage(task.stage);
		}
		for (const task of terminalTasks?.items ?? []) {
			addStage(task.stage);
		}

		return [...seen].sort(
			(left, right) =>
				(RUNNING_TASK_STAGE_ORDER[left] ?? Number.MAX_SAFE_INTEGER) -
				(RUNNING_TASK_STAGE_ORDER[right] ?? Number.MAX_SAFE_INTEGER),
		);
	}, [queuePendingCounts, sortedInProgressTasks, terminalTasks?.items]);
	const filteredInProgressTasks = useMemo(() => {
		const query = taskSearchQuery.trim().toLowerCase();
		return sortedInProgressTasks.filter((task) => {
			if (
				runningTaskStageFilter !== "all" &&
				task.stage !== runningTaskStageFilter
			) {
				return false;
			}
			if (!query) {
				return true;
			}
			return [
				task.title,
				task.subtitle || "",
				task.stage || "",
				getTaskStageLabel(t, task.stage),
				task.taskId,
			]
				.join("\n")
				.toLowerCase()
				.includes(query);
		});
	}, [sortedInProgressTasks, taskSearchQuery, runningTaskStageFilter, t]);
	const runningTaskPagination = useMemo(() => {
		const totalItems = filteredInProgressTasks.length;
		const totalPages = Math.max(1, Math.ceil(totalItems / runningTaskPageSize));
		const page = Math.min(Math.max(1, runningTaskPage), totalPages);
		const startIndex = (page - 1) * runningTaskPageSize;
		const endIndex = Math.min(totalItems, startIndex + runningTaskPageSize);
		return {
			page,
			pageSize: runningTaskPageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items: filteredInProgressTasks.slice(startIndex, endIndex),
		};
	}, [filteredInProgressTasks, runningTaskPage, runningTaskPageSize]);
	const finishedTaskPagination = useMemo(() => {
		const totalItems = terminalTasks?.total ?? 0;
		const pageSize = terminalTasks?.pageSize ?? finishedTaskPageSize;
		const totalPages =
			terminalTasks?.totalPages ??
			Math.max(1, Math.ceil(totalItems / pageSize));
		const page =
			terminalTasks?.page ??
			Math.min(Math.max(1, finishedTaskPage), totalPages);
		const startIndex = totalItems > 0 ? (page - 1) * pageSize : 0;
		const items = terminalTasks?.items ?? [];
		const endIndex = Math.min(totalItems, startIndex + items.length);
		return {
			page,
			pageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items,
		};
	}, [finishedTaskPage, finishedTaskPageSize, terminalTasks]);
	const currentPageRerunnableFinishedTaskIds = useMemo(
		() =>
			finishedTaskPagination.items
				.filter((task) => RERUNNABLE_TASK_STATUSES.has(task.status))
				.map((task) => task.taskId),
		[finishedTaskPagination.items],
	);
	const selectedCurrentPageFinishedTasks = useMemo(
		() =>
			finishedTaskPagination.items.filter((task) =>
				selectedFinishedTaskIds.has(task.taskId),
			),
		[finishedTaskPagination.items, selectedFinishedTaskIds],
	);
	const selectedFinishedTaskCount = selectedCurrentPageFinishedTasks.length;
	const hasCurrentPageRerunnableFinishedTasks =
		currentPageRerunnableFinishedTaskIds.length > 0;
	const areAllCurrentPageFinishedTasksSelected =
		hasCurrentPageRerunnableFinishedTasks &&
		currentPageRerunnableFinishedTaskIds.every((taskId) =>
			selectedFinishedTaskIds.has(taskId),
		);
	const areSomeCurrentPageFinishedTasksSelected =
		selectedFinishedTaskCount > 0 && !areAllCurrentPageFinishedTasksSelected;

	useEffect(() => {
		if (runningTaskPage !== runningTaskPagination.page) {
			setRunningTaskPage(runningTaskPagination.page);
		}
	}, [runningTaskPage, runningTaskPagination.page]);

	useEffect(() => {
		if (finishedTaskPage !== finishedTaskPagination.page) {
			setFinishedTaskPage(finishedTaskPagination.page);
		}
	}, [finishedTaskPage, finishedTaskPagination.page]);

	useEffect(() => {
		const currentPageIds = new Set(currentPageRerunnableFinishedTaskIds);
		setSelectedFinishedTaskIds((current) => {
			let changed = false;
			const next = new Set<string>();
			for (const taskId of current) {
				if (currentPageIds.has(taskId)) {
					next.add(taskId);
				} else {
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [currentPageRerunnableFinishedTaskIds]);

	useEffect(() => {
		if (
			runningTaskStageFilter !== "all" &&
			!taskStageOptions.includes(runningTaskStageFilter)
		) {
			setRunningTaskStageFilter("all");
			setRunningTaskPage(1);
		}
		if (
			finishedTaskStageFilter !== "all" &&
			!taskStageOptions.includes(finishedTaskStageFilter)
		) {
			setFinishedTaskStageFilter("all");
			setFinishedTaskPage(1);
		}
	}, [finishedTaskStageFilter, runningTaskStageFilter, taskStageOptions]);

	useEffect(() => {
		if (
			sortedInProgressTasks.length === 0 &&
			scanJob?.status !== "running" &&
			scanJob?.status !== "pending"
		) {
			return;
		}
		const timer = window.setInterval(() => {
			setRuntimeNowMs(Date.now());
		}, 1000);
		return () => window.clearInterval(timer);
	}, [sortedInProgressTasks.length, scanJob?.status]);

	const handleAnalyzeCandidate = async (candidate: {
		vulnerabilityCandidateId: string;
		scanJobId: string;
		scanFunctionTaskId?: string | null;
	}) => {
		const reanalysisKey = buildCandidateReanalysisKey(candidate);
		setReanalyzingCandidateId(reanalysisKey);
		try {
			const result = await analyzeCandidateMutation.mutateAsync({
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				scanJobId: candidate.scanJobId,
				scanFunctionTaskId: candidate.scanFunctionTaskId || undefined,
			});
			toast.success(
				scanT(t, "scan.candidates.analysisRequeued", "Analysis requeued"),
			);
			await Promise.all([
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.statusView.invalidate({ scanJobId }),
				utils.scan.candidates.invalidate({ scanJobId }),
			]);
			await router.push(
				`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}?tab=tasks&taskId=${encodeURIComponent(
					result.taskId,
				)}`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(
							t,
							"scan.candidates.analysisRequeueError",
							"Failed to requeue analysis",
						),
			);
		} finally {
			setReanalyzingCandidateId((current) =>
				current === reanalysisKey ? null : current,
			);
		}
	};

	const handleStartCandidateReviewContainer = async () => {
		const candidateIds = selectedCurrentPageCandidates.map(
			(candidate) => candidate.vulnerabilityCandidateId,
		);
		if (candidateIds.length === 0) {
			return;
		}

		try {
			const result = await startCandidateReviewContainerMutation.mutateAsync({
				scanJobId,
				candidateIds,
			});
			window.open(result.terminalUrl, "_blank", "noopener,noreferrer");
			toast.success(
				scanT(
					t,
					"scan.candidates.mountAndStartContainerOpened",
					"Review container started",
				),
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(
							t,
							"scan.candidates.mountAndStartContainerError",
							"Failed to start review container",
						),
			);
		}
	};
	const handleRerunTask = async (taskId: string) => {
		setRerunningTaskId(taskId);
		try {
			const result = await rerunTaskMutation.mutateAsync({ taskId });
			toast.success(
				scanT(t, "scan.task.rerunCreated", "Created rerun task {{id}}", {
					id: result.task.taskId,
				}),
			);
			await Promise.all([
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.statusView.invalidate({ scanJobId }),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(t, "scan.task.rerunError", "Failed to rerun task"),
			);
		} finally {
			setRerunningTaskId((current) => (current === taskId ? null : current));
		}
	};

	const toggleFinishedTaskSelection = (taskId: string) => {
		setSelectedFinishedTaskIds((current) => {
			const next = new Set(current);
			if (next.has(taskId)) {
				next.delete(taskId);
			} else {
				next.add(taskId);
			}
			return next;
		});
	};

	const toggleCurrentPageFinishedTaskSelection = () => {
		setSelectedFinishedTaskIds((current) => {
			if (areAllCurrentPageFinishedTasksSelected) {
				return new Set();
			}
			return new Set([...current, ...currentPageRerunnableFinishedTaskIds]);
		});
	};

	const handleRerunSelectedFinishedTasks = async () => {
		const taskIds = selectedCurrentPageFinishedTasks
			.filter((task) => RERUNNABLE_TASK_STATUSES.has(task.status))
			.map((task) => task.taskId);
		if (taskIds.length === 0) {
			return;
		}

		setBulkRerunningTaskIds(new Set(taskIds));
		let createdCount = 0;
		let failedCount = 0;
		let firstError: string | null = null;
		try {
			for (const taskId of taskIds) {
				try {
					await rerunTaskMutation.mutateAsync({ taskId });
					createdCount += 1;
				} catch (error) {
					failedCount += 1;
					firstError ??=
						error instanceof Error
							? error.message
							: scanT(t, "scan.task.rerunError", "Failed to rerun task");
				}
			}

			if (createdCount > 0) {
				setSelectedFinishedTaskIds(new Set());
			}
			if (failedCount > 0) {
				toast.error(
					scanT(
						t,
						"scan.task.bulkRerunPartialError",
						"Created {{created}} rerun tasks; {{failed}} failed. {{error}}",
						{
							created: createdCount,
							failed: failedCount,
							error: firstError || "",
						},
					),
				);
			} else {
				toast.success(
					scanT(
						t,
						"scan.task.bulkRerunCreated",
						"Created rerun tasks for {{count}} selected tasks",
						{ count: createdCount },
					),
				);
			}
			await Promise.all([
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.statusView.invalidate({ scanJobId }),
				utils.scan.terminalTasks.invalidate(),
			]);
		} finally {
			setBulkRerunningTaskIds(new Set());
		}
	};
	const candidatePagination = useMemo(() => {
		const totalItems = candidates?.total ?? 0;
		const pageSize = candidates?.pageSize ?? candidatePageSize;
		const totalPages =
			candidates?.totalPages ?? Math.max(1, Math.ceil(totalItems / pageSize));
		const safePage =
			candidates?.page ?? Math.min(Math.max(1, candidatePage), totalPages);
		const startIndex = totalItems > 0 ? (safePage - 1) * pageSize : 0;
		const items = candidates?.items ?? [];
		const endIndex = Math.min(totalItems, startIndex + items.length);
		return {
			page: safePage,
			pageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items,
		};
	}, [candidatePage, candidatePageSize, candidates]);
	type CandidateListItem = (typeof candidatePagination.items)[number];
	const currentPageCandidateIds = useMemo(
		() =>
			candidatePagination.items.map(
				(candidate) => candidate.vulnerabilityCandidateId,
			),
		[candidatePagination.items],
	);
	const selectedCurrentPageCandidates = useMemo(
		() =>
			candidatePagination.items.filter((candidate) =>
				selectedCandidateIds.has(candidate.vulnerabilityCandidateId),
			),
		[candidatePagination.items, selectedCandidateIds],
	);
	const selectedCandidateCount = selectedCurrentPageCandidates.length;
	const hasCurrentPageCandidates = currentPageCandidateIds.length > 0;
	const areAllCurrentPageCandidatesSelected =
		hasCurrentPageCandidates &&
		currentPageCandidateIds.every((candidateId) =>
			selectedCandidateIds.has(candidateId),
		);
	const areSomeCurrentPageCandidatesSelected =
		selectedCandidateCount > 0 && !areAllCurrentPageCandidatesSelected;
	const selectedExportFieldSet = useMemo(
		() => new Set(candidateExportFields),
		[candidateExportFields],
	);
	const hasSelectedExportFields = candidateExportFields.length > 0;

	useEffect(() => {
		if (candidatePage !== candidatePagination.page) {
			setCandidatePage(candidatePagination.page);
		}
	}, [candidatePage, candidatePagination.page]);
	useEffect(() => {
		const currentPageIds = new Set(currentPageCandidateIds);
		setSelectedCandidateIds((current) => {
			let changed = false;
			const next = new Set<string>();
			for (const candidateId of current) {
				if (currentPageIds.has(candidateId)) {
					next.add(candidateId);
				} else {
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [currentPageCandidateIds]);
	const hasCandidateFilters =
		candidateQuery.trim().length > 0 ||
		analysisFilters.length > 0 ||
		verifyFilters.length > 0 ||
		triageFilters.length > 0;
	const hasAnyCandidates =
		(statusView?.summary.totalCandidates ?? candidates?.total ?? 0) > 0;
	const hasFinishedTaskFilters =
		taskSearchQuery.trim().length > 0 ||
		finishedTaskStageFilter !== "all" ||
		taskStatusFilter !== "all";
	const getCandidateLatestResultUpdate = (
		candidate: CandidateListItem,
	): {
		date: string;
		stageKey: string;
		stageLabel: string;
		timestamp: number;
	} | null => {
		const resultUpdates: Array<{
			date: string;
			stageKey: string;
			stageLabel: string;
			timestamp: number;
		}> = [];
		for (const item of [
			{
				date: candidate.latestAnalysisResult?.updatedAt,
				stageKey: "scan.stage.analyze",
				stageLabel: "Analyze",
			},
			{
				date: candidate.latestVerificationResult?.updatedAt,
				stageKey: "scan.stage.verify",
				stageLabel: "Verify",
			},
			{
				date: candidate.latestTriageResult?.updatedAt,
				stageKey: "scan.stage.triage",
				stageLabel: "Triage",
			},
		]) {
			if (!item.date) {
				continue;
			}
			const timestamp = Date.parse(item.date);
			if (!Number.isFinite(timestamp)) {
				continue;
			}
			resultUpdates.push({ ...item, date: item.date, timestamp });
		}
		resultUpdates.sort((left, right) => right.timestamp - left.timestamp);

		return resultUpdates[0] || null;
	};

	const toggleCandidateSort = (key: CandidateSortKey) => {
		if (candidateSortKey === key) {
			setCandidateSortDirection((current) =>
				current === "asc" ? "desc" : "asc",
			);
			return;
		}
		setCandidateSortKey(key);
		setCandidateSortDirection(
			key === "latestResultUpdatedAt" || key === "createdAt" ? "desc" : "asc",
		);
	};

	const toggleAnalysisFilter = (value: string) => {
		setCandidatePage(1);
		setAnalysisFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const toggleVerifyFilter = (value: string) => {
		setCandidatePage(1);
		setVerifyFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const toggleTriageFilter = (value: string) => {
		setCandidatePage(1);
		setTriageFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const toggleCandidateSelection = (candidateId: string) => {
		setSelectedCandidateIds((current) => {
			const next = new Set(current);
			if (next.has(candidateId)) {
				next.delete(candidateId);
			} else {
				next.add(candidateId);
			}
			return next;
		});
	};

	const toggleCurrentPageCandidateSelection = () => {
		setSelectedCandidateIds((current) => {
			if (areAllCurrentPageCandidatesSelected) {
				return new Set();
			}
			return new Set([...current, ...currentPageCandidateIds]);
		});
	};

	const toggleCandidateExportField = (field: CandidateExportField) => {
		setCandidateExportFields((current) =>
			current.includes(field)
				? current.filter((item) => item !== field)
				: [...current, field],
		);
	};

	const buildCandidateExportRecord = (candidate: CandidateListItem) => {
		const candidateWithHostPaths = candidate as CandidateListItem & {
			fileHostPath?: string | null;
			latestAnalysisResult?:
				| (CandidateListItem["latestAnalysisResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
			latestVerificationResult?:
				| (CandidateListItem["latestVerificationResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
			latestTriageResult?:
				| (CandidateListItem["latestTriageResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
		};
		const latestAnalysisResult = candidateWithHostPaths.latestAnalysisResult;
		const latestVerificationResult =
			candidateWithHostPaths.latestVerificationResult;
		const latestTriageResult = candidateWithHostPaths.latestTriageResult;
		const exportableFields: Record<CandidateExportField, unknown> = {
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			scanJobId: candidate.scanJobId,
			scanFunctionTaskId: candidate.scanFunctionTaskId,
			title: candidate.title,
			description: candidate.description,
			fileHostPath: candidateWithHostPaths.fileHostPath,
			line: candidate.line,
			vulnerabilityType: candidate.vulnerabilityType,
			status: candidate.status,
			currentStage: candidate.currentStage,
			confidence: candidate.confidence,
			score: candidate.score,
			createdAt: candidate.createdAt,
			updatedAt: candidate.updatedAt,
			analysisTaskId: latestAnalysisResult?.taskId ?? null,
			analysisResult: latestAnalysisResult?.result ?? null,
			analysisConfidence: latestAnalysisResult?.confidence ?? null,
			analysisScore: latestAnalysisResult?.score ?? null,
			analysisSummary: latestAnalysisResult?.summary ?? null,
			analysisReportHostPath: latestAnalysisResult?.reportHostPath ?? null,
			analysisRuntimeSeconds: latestAnalysisResult?.runtimeSeconds ?? null,
			analysisThreadId: latestAnalysisResult?.threadId ?? null,
			analysisCreatedAt: latestAnalysisResult?.createdAt ?? null,
			analysisUpdatedAt: latestAnalysisResult?.updatedAt ?? null,
			verificationTaskId: latestVerificationResult?.taskId ?? null,
			verificationResult: latestVerificationResult?.result ?? null,
			verificationConfidence: latestVerificationResult?.confidence ?? null,
			verificationScore: latestVerificationResult?.score ?? null,
			verificationSummary: latestVerificationResult?.summary ?? null,
			verificationReportHostPath:
				latestVerificationResult?.reportHostPath ?? null,
			verificationRuntimeSeconds:
				latestVerificationResult?.runtimeSeconds ?? null,
			verificationThreadId: latestVerificationResult?.threadId ?? null,
			verificationCreatedAt: latestVerificationResult?.createdAt ?? null,
			verificationUpdatedAt: latestVerificationResult?.updatedAt ?? null,
			triageTaskId: latestTriageResult?.taskId ?? null,
			triageResult: latestTriageResult?.result ?? null,
			triageDisqualifier: latestTriageResult?.disqualifier ?? null,
			triageDisqualifierReason:
				latestTriageResult?.disqualifierReason ?? null,
			triageSecurityClassification:
				latestTriageResult?.securityClassification ?? null,
			triageIsSecurityIssue: latestTriageResult?.isSecurityIssue ?? null,
			triageImpactType: latestTriageResult?.impactType ?? null,
			triageCvssVector: latestTriageResult?.cvssVector ?? null,
			triageCvssScore: latestTriageResult?.cvssScore ?? null,
			triageCvssSeverity: latestTriageResult?.cvssSeverity ?? null,
			triageExploitability: latestTriageResult?.exploitability ?? null,
			triageIsExploitable: latestTriageResult?.isExploitable ?? null,
			triageEpssProbability30d: latestTriageResult?.epssProbability30d ?? null,
			triageEpssSource: latestTriageResult?.epssSource ?? null,
			triageSummary: latestTriageResult?.summary ?? null,
			triageReportHostPath: latestTriageResult?.reportHostPath ?? null,
		};
		return Object.fromEntries(
			CANDIDATE_EXPORT_FIELDS.filter((field) =>
				selectedExportFieldSet.has(field.key),
			).map((field) => [field.key, exportableFields[field.key]]),
		);
	};

	const buildCandidateExportJson = () =>
		JSON.stringify(
			selectedCurrentPageCandidates.map((candidate) =>
				buildCandidateExportRecord(candidate),
			),
			null,
			2,
		);

	const downloadSelectedCandidatesJson = () => {
		const exportJson = buildCandidateExportJson();
		const blob = new Blob([exportJson], { type: "application/json" });
		const objectUrl = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = objectUrl;
		anchor.download = buildCandidateExportFilename(scanJobId);
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(objectUrl);
		toast.success(
			scanT(t, "scan.candidates.downloaded", "Candidate JSON downloaded"),
		);
	};

	const copySelectedCandidatesJson = async () => {
		try {
			await copyTextToClipboard(buildCandidateExportJson());
			toast.success(scanT(t, "scan.candidates.copied", "Candidate JSON copied"));
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(
							t,
							"scan.candidates.copyFailed",
							"Failed to copy candidate JSON",
						),
			);
		}
	};

	const candidateListPageBasePath = `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}`;

	const candidateScrollStorageKey = useMemo(
		() =>
			`scan-candidates-scroll:${buildCandidateListStateHref(
				candidateListPageBasePath,
				currentCandidateListState,
				"candidates",
			)}`,
		[candidateListPageBasePath, currentCandidateListState],
	);

	useEffect(() => {
		if (
			typeof window === "undefined" ||
			!router.isReady ||
			activeTab !== "candidates"
		) {
			return;
		}

		if (restoredCandidateScrollKeyRef.current === candidateScrollStorageKey) {
			return;
		}

		const rawScrollY = window.sessionStorage.getItem(candidateScrollStorageKey);
		if (!rawScrollY) {
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			return;
		}

		const scrollY = Number.parseFloat(rawScrollY);
		if (!Number.isFinite(scrollY) || scrollY < 0) {
			window.sessionStorage.removeItem(candidateScrollStorageKey);
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			return;
		}

		requestAnimationFrame(() => {
			window.scrollTo({ top: scrollY, behavior: "auto" });
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			window.sessionStorage.removeItem(candidateScrollStorageKey);
		});
	}, [
		activeTab,
		candidatePagination.page,
		candidateScrollStorageKey,
		router.isReady,
	]);

	const buildCandidateDetailHref = (
		candidate: Pick<
			CandidateListItem,
			"vulnerabilityCandidateId" | "scanFunctionTaskId"
		>,
	) => {
		const href = buildCandidateListStateHref(
			`${candidateListPageBasePath}/candidates/${encodeURIComponent(
				candidate.vulnerabilityCandidateId,
			)}`,
			currentCandidateListState,
			"candidates",
		);
		if (!candidate.scanFunctionTaskId) {
			return href;
		}
		const separator = href.includes("?") ? "&" : "?";
		return `${href}${separator}scanFunctionTaskId=${encodeURIComponent(
			candidate.scanFunctionTaskId,
		)}`;
	};
	const buildTaskDetailHref = (taskId: string) =>
		`${candidateListPageBasePath}/tasks/${encodeURIComponent(taskId)}`;
	const shouldIgnoreTaskRowClick = (target: EventTarget | null) =>
		target instanceof Element &&
		!!target.closest("a,button,input,textarea,select,[data-task-row-action]");
	const handleTaskRowClick = (
		event: MouseEvent<HTMLTableRowElement>,
		taskId: string,
	) => {
		if (shouldIgnoreTaskRowClick(event.target)) {
			return;
		}
		void router.push(buildTaskDetailHref(taskId));
	};
	const handleTaskRowKeyDown = (
		event: KeyboardEvent<HTMLTableRowElement>,
		taskId: string,
	) => {
		if (shouldIgnoreTaskRowClick(event.target)) {
			return;
		}
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		event.preventDefault();
		void router.push(buildTaskDetailHref(taskId));
	};
	const handleCandidateLinkClick = () => {
		if (typeof window === "undefined") {
			return;
		}
		window.sessionStorage.setItem(
			candidateScrollStorageKey,
			String(window.scrollY),
		);
	};

	useEffect(() => {
		if (activeTab !== "files") {
			return;
		}

		if (rootDirectoryQuery.isLoading) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: {
					items: current[ROOT_DIRECTORY_KEY]?.items || [],
					status: "loading",
				},
			}));
			return;
		}

		if (rootDirectoryQuery.isError) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: { items: [], status: "error" },
			}));
			setSelectedFilePath(null);
			return;
		}

		const items = rootDirectoryQuery.data || [];
		setDirectoryCache((current) => ({
			...current,
			[ROOT_DIRECTORY_KEY]: { items, status: "loaded" },
		}));

		if (!items.length) {
			setSelectedFilePath(null);
			return;
		}

		const firstFile = items.find((item) => item.type === "file")?.id || null;
		if (!firstFile) {
			return;
		}
		setSelectedFilePath((current) => current || firstFile);
	}, [
		activeTab,
		rootDirectoryQuery.data,
		rootDirectoryQuery.isError,
		rootDirectoryQuery.isLoading,
	]);

	const handleToggleDirectory = async (directoryPath: string) => {
		const nextExpanded = !expandedDirectories[directoryPath];
		setExpandedDirectories((current) => ({
			...current,
			[directoryPath]: nextExpanded,
		}));

		if (!nextExpanded) {
			return;
		}

		const existing = directoryCache[directoryPath];
		if (existing?.status === "loading") {
			return;
		}

		setDirectoryCache((current) => ({
			...current,
			[directoryPath]: {
				items: current[directoryPath]?.items || [],
				status: "loading",
			},
		}));

		try {
			const items = await utils.scan.listDirectory.fetch({
				scanJobId,
				directoryPath,
			});
			setDirectoryCache((current) => ({
				...current,
				[directoryPath]: { items, status: "loaded" },
			}));
		} catch {
			setDirectoryCache((current) => ({
				...current,
				[directoryPath]: { items: [], status: "error" },
			}));
		}
	};

	return (
		<div className="pb-10">
			<BreadcrumbSidebar
				list={[
					{ name: scanT(t, "scan.breadcrumb.projects", "Projects"), href: "/dashboard/projects" },
					{ name: serviceData?.environment.project.name || "" },
					{
						name: serviceData?.environment.name || "",
						href: `/dashboard/project/${projectId}/environment/${environmentId}`,
					},
					{
						name: serviceData?.name || "",
						href: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`,
					},
					{
						name: scanT(t, "scan.jobs.title", "Jobs"),
						href: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`,
					},
					{
						name: scanT(t, "scan.job.shortTitle", "Job {{id}}", {
							id: scanJobId.slice(0, 6),
						}),
					},
				]}
			/>
			<Head>
				<title>
					{scanT(t, "scan.job.title", "Scan Job {{id}}", {
						id: scanJobId.slice(0, 6),
					})}{" "}
					| Dokploy
				</title>
			</Head>

			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">
						{scanT(t, "scan.job.title", "Scan Job {{id}}", {
							id: scanJobId.slice(0, 6),
						})}
					</CardTitle>
					<CardDescription className="flex items-center gap-2 break-all">
						<span>{scanJobId}</span>
						<CopyValueButton
							value={scanJobId}
							label={scanT(t, "scan.field.jobId", "Job ID")}
							className="size-7 shrink-0"
						/>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Tabs
						value={activeTab}
						onValueChange={(value) => {
							setActiveTab(value as ScanJobTab);
						}}
						className="w-full"
					>
						<TabsList className="flex h-auto min-h-10 w-full justify-start gap-1 overflow-x-auto p-1 sm:gap-2">
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="overview">
								{scanT(t, "scan.job.tabs.overview", "Overview")}
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="tasks">
								{scanT(t, "scan.job.tabs.tasks", "阶段任务")}
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="candidates">
								{scanT(t, "scan.job.tabs.candidates", "Candidates")}
							</TabsTrigger>
							{serviceType === "application" ? (
								<TabsTrigger
									className="shrink-0 px-2 sm:px-3"
									value="evaluate"
								>
									{scanT(t, "scan.evaluate.title", "Evaluate")}
								</TabsTrigger>
							) : null}
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="monitoring">
								{scanT(t, "scan.monitoring.title", "Monitoring")}
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="files">
								{scanT(t, "scan.files.title", "Files")}
							</TabsTrigger>
						</TabsList>

						<TabsContent value="overview" className="pt-4">
							{isLoadingJob ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									{scanT(t, "scan.job.loading", "Loading job...")}
								</div>
							) : !scanJob ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<AlertCircle className="size-4" />
									{scanT(t, "scan.job.notFound", "Job not found")}
								</div>
							) : (
								<div className="flex flex-col gap-3">
									<div className="rounded-lg border p-4">
										<div className="mb-3 text-lg font-semibold">
											{scanT(t, "scan.actions.title", "Actions")}
										</div>
										{canPauseScanJob || canResumeScanJob || canCancelScanJob ? (
											<div className="flex flex-wrap gap-2">
												{canPauseScanJob ? (
													<Button
														type="button"
														variant="outline"
														disabled={pauseScanJobMutation.isLoading}
														onClick={async () => {
															try {
																const result =
																	await pauseScanJobMutation.mutateAsync({
																		scanJobId,
																	});
																toast.success(
																	scanT(
																		t,
																		"scan.job.pausedToast",
																		"Paused job. Stopped {{count}} runtimes.",
																		{ count: result.stoppedRuntimes },
																	),
																);
																await refreshScanJobViews();
															} catch (error) {
																toast.error(
																	error instanceof Error
																		? error.message
																		: scanT(
																				t,
																				"scan.job.pauseError",
																				"Failed to pause scan job",
																			),
																);
															}
														}}
													>
														{pauseScanJobMutation.isLoading ? (
															<>
																<Loader2 className="mr-2 size-4 animate-spin" />
																{scanT(t, "scan.job.pausing", "Pausing...")}
															</>
														) : (
															<>
																<Pause className="mr-2 size-4" />
																{scanT(t, "scan.job.pause", "Pause")}
															</>
														)}
													</Button>
												) : null}
												{canResumeScanJob ? (
													<Button
														type="button"
														variant="outline"
														disabled={resumeScanJobMutation.isLoading}
														onClick={async () => {
															try {
																await resumeScanJobMutation.mutateAsync({
																	scanJobId,
																});
																toast.success(
																	scanT(t, "scan.job.resumedToast", "Resumed job"),
																);
																await refreshScanJobViews();
															} catch (error) {
																toast.error(
																	error instanceof Error
																		? error.message
																		: scanT(
																				t,
																				"scan.job.resumeError",
																				"Failed to resume scan job",
																			),
																);
															}
														}}
													>
														{resumeScanJobMutation.isLoading ? (
															<>
																<Loader2 className="mr-2 size-4 animate-spin" />
																{scanT(t, "scan.job.resuming", "Resuming...")}
															</>
														) : (
															<>
																<Play className="mr-2 size-4" />
																{scanT(t, "scan.job.resume", "Resume")}
															</>
														)}
													</Button>
												) : null}
												{canCancelScanJob ? (
													<Button
														type="button"
														variant="destructive"
														disabled={cancelScanJobMutation.isLoading}
														onClick={async () => {
															try {
																const result =
																	await cancelScanJobMutation.mutateAsync({
																		scanJobId,
																	});
																toast.success(
																	scanT(
																		t,
																		"scan.job.cancelledToast",
																		"Cancelled job. Stopped {{count}} containers.",
																		{ count: result.stoppedContainers },
																	),
																);
																await refreshScanJobViews();
															} catch (error) {
																toast.error(
																	error instanceof Error
																		? error.message
																		: scanT(
																				t,
																				"scan.job.cancelError",
																				"Failed to cancel scan job",
																			),
																);
															}
														}}
													>
														{cancelScanJobMutation.isLoading ? (
															<>
																<Loader2 className="mr-2 size-4 animate-spin" />
																{scanT(t, "scan.job.cancelling", "Cancelling...")}
															</>
														) : (
															scanT(t, "scan.dialog.cancel", "Cancel")
														)}
													</Button>
												) : null}
											</div>
										) : (
											<div className="text-sm text-muted-foreground">
												{scanT(
													t,
													"scan.job.noActions",
													"No actions available for this job status.",
												)}
											</div>
										)}
									</div>
									<ScanStageGraph scanJobId={scanJobId} />
									<Card className="bg-background">
										<CardHeader>
											<CardTitle className="text-xl">
												{scanT(t, "scan.results.title", "Results")}
											</CardTitle>
											<CardDescription>
												{scanT(
													t,
													"scan.results.description",
													"Latest candidate results across analysis, verification, and triage.",
												)}
											</CardDescription>
										</CardHeader>
										<CardContent className="grid gap-4">
											<div className="rounded-lg border p-3">
												<div className="mb-3 flex items-center justify-between gap-3">
													<div>
														<div className="font-medium">
															{scanT(
																t,
																"scan.results.flowTitle",
																"Candidate Flow",
															)}
														</div>
														<div className="text-sm text-muted-foreground">
															{scanT(
																t,
																"scan.results.flowDescription",
																"Sankey-style flow from positive analysis results through verification and triage.",
															)}
														</div>
													</div>
													{isLoadingResultSummary ? (
														<Loader2 className="size-4 animate-spin text-muted-foreground" />
													) : null}
												</div>
												<ResultFlowChart summary={resultSummary} t={t} />
											</div>
										</CardContent>
									</Card>
									<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.field.status", "Status")}
											</div>
											<div
												className={`font-medium ${getScanJobStatusClassName(scanJob.status)}`}
											>
												{getScanJobStatusLabel(t, scanJob.status)}
											</div>
										</div>
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.field.scanType", "Scan Type")}
											</div>
											<div className="font-medium">
												{formatScanTypeLabel(t, scanJob.scanType)}
											</div>
										</div>
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.field.trigger", "Trigger")}
											</div>
											<div className="font-medium">
												{formatTriggerSourceLabel(t, scanJob.triggerSource)}
											</div>
										</div>
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.field.duration", "Duration")}
											</div>
											<div className="font-medium tabular-nums">
												{formatDurationSeconds(
													resultSummary?.taskTimeline.coveredSeconds,
												)}
											</div>
										</div>
										<div className="border rounded-lg p-3 md:col-span-2">
											<div className="mb-3 text-sm font-medium">
												{scanT(t, "scan.section.usage", "Usage")}
											</div>
											<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
												<div>
													<div className="text-sm text-muted-foreground">
														{scanT(t, "scan.field.inputCacheRead", "Input / Cache Read")}
													</div>
													<div className="font-medium">
														{formatTokenUsageWithCache(
															t,
															scanJob.inputTokens,
															scanJob.cachedReadTokens,
														)}
													</div>
												</div>
												<div>
													<div className="text-sm text-muted-foreground">
														{scanT(t, "scan.field.outputTokens", "Output Tokens")}
													</div>
													<div className="font-medium">
														{formatTokenUsage(t, scanJob.outputTokens)}
													</div>
												</div>
												<div>
													<div className="text-sm text-muted-foreground">
														{scanT(t, "scan.field.totalTokens", "Total Tokens")}
													</div>
													<div className="font-medium">
														{formatTokenUsage(t, scanJob.totalTokens)}
													</div>
												</div>
												<div>
													<div className="text-sm text-muted-foreground">
														{scanT(t, "scan.field.thoughtTokens", "Thought Tokens")}
													</div>
													<div className="font-medium">
														{formatTokenUsage(t, scanJob.thoughtTokens)}
													</div>
												</div>
												{typeof scanJob.estimatedCost === "number" && scanJob.estimatedCost > 0 ? (
													<div>
														<div className="text-sm text-muted-foreground">
															{scanT(t, "scan.field.estimatedCost", "Estimated Cost")}
														</div>
														<div className="font-medium">
															${scanJob.estimatedCost.toFixed(4)}
														</div>
													</div>
												) : null}
											</div>
										</div>
										{scanJob.scanType === "delta" ? (
											<div className="border rounded-lg p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.commitWindow", "Commit Window")}
												</div>
												<div className="font-medium">
													k={scanJob.commitWindow}
												</div>
											</div>
										) : null}
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.field.created", "Created")}
											</div>
											<div className="font-medium">
												<DateTooltip date={scanJob.createdAt} />
											</div>
										</div>
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.status.finished", "Finished")}
											</div>
											<div className="font-medium">
												{scanJob.finishedAt ? (
													<DateTooltip date={scanJob.finishedAt} />
												) : (
													"-"
												)}
											</div>
										</div>
										{scanJob.errorMessage && (
											<div className="border rounded-lg p-3 md:col-span-2">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.errorMessage", "Error")}
												</div>
												<div className="font-medium text-destructive break-all">
													{scanJob.errorMessage}
												</div>
											</div>
										)}
										<div className="border rounded-lg p-3 md:col-span-2">
											<div className="flex items-start justify-between gap-3">
												<div>
													<div className="text-sm text-muted-foreground">
														{scanT(t, "scan.candidate.note", "Note")}
													</div>
													<div className="text-xs text-muted-foreground">
														{scanT(
															t,
															"scan.job.noteDescription",
															"Internal note for this scan job",
														)}
													</div>
												</div>
												<Button
													type="button"
													size="sm"
													disabled={
														updateNoteMutation.isLoading ||
														!isNoteDirty ||
														!scanJob
													}
													onClick={async () => {
														try {
															await updateNoteMutation.mutateAsync({
																scanJobId,
																note: noteDraft,
															});
															toast.success(scanT(t, "scan.job.noteSaved", "Note saved"));
															await Promise.all([
																utils.scan.one.invalidate({ scanJobId }),
																serviceType === "application"
																	? utils.scan.allByApplication.invalidate({
																			applicationId: serviceId,
																		})
																	: utils.scan.allByCompose.invalidate({
																			composeId: serviceId,
																		}),
															]);
														} catch (error) {
															toast.error(
																error instanceof Error
																	? error.message
																	: scanT(
																			t,
																			"scan.job.noteSaveError",
																			"Failed to save note",
																		),
															);
														}
													}}
												>
													{updateNoteMutation.isLoading ? (
														<>
															<Loader2 className="mr-2 size-4 animate-spin" />
															{scanT(t, "scan.common.saving", "Saving...")}
														</>
													) : (
														scanT(t, "scan.dialog.save", "Save")
													)}
												</Button>
											</div>
											<Textarea
												value={noteDraft}
												onChange={(event) => setNoteDraft(event.target.value)}
												placeholder={scanT(
													t,
													"scan.job.notePlaceholder",
													"Add a note for this scan job...",
												)}
												className="mt-3 min-h-[96px] resize-y"
											/>
										</div>
									</div>
								</div>
							)}
						</TabsContent>

						<TabsContent value="evaluate" className="pt-4">
							{serviceType !== "application" ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<AlertCircle className="size-4" />
									{scanT(
										t,
										"scan.evaluate.applicationOnly",
										"Evaluate is only available for application scan jobs.",
									)}
								</div>
							) : isLoadingJob ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									{scanT(t, "scan.job.loading", "Loading job...")}
								</div>
							) : !scanJob ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<AlertCircle className="size-4" />
									{scanT(t, "scan.job.notFound", "Job not found")}
								</div>
							) : (
								<div className="grid gap-4">
									<div className="rounded-lg border p-4">
										<div className="flex flex-wrap items-center justify-between gap-3">
											<div>
												<div className="text-lg font-semibold">
													{scanT(t, "scan.evaluate.title", "Evaluate")}
												</div>
												<div className="text-sm text-muted-foreground">
													{scanT(
														t,
														"scan.evaluate.description",
														"Latest manual evaluation against configured ground truth.",
													)}
												</div>
											</div>
											<Button
												type="button"
												variant="outline"
												disabled={
													!canEvaluateScanJob ||
													startEvaluationMutation.isLoading
												}
												onClick={() => {
													setEvaluateAgentProfileIdDraft(
														applicationEvaluateConfig?.agentProfileId || "",
													);
													setEvaluateGroundTruthPathDraft(
														applicationEvaluateConfig?.groundTruthPath ?? "",
													);
													setIsEvaluateDialogOpen(true);
												}}
											>
												{startEvaluationMutation.isLoading ? (
													<>
														<Loader2 className="mr-2 size-4 animate-spin" />
														{scanT(t, "scan.evaluate.starting", "Starting...")}
													</>
												) : (
													<>
														<ClipboardCheck className="mr-2 size-4" />
														{scanT(t, "scan.evaluate.action", "Evaluate")}
													</>
												)}
											</Button>
										</div>
									</div>
									<Card className="bg-background">
										<CardHeader>
											<div className="flex items-start justify-between gap-3">
												<div>
													<CardTitle className="text-xl">
														{scanT(t, "scan.evaluate.latest", "Latest Result")}
													</CardTitle>
													<CardDescription>
														{scanT(
															t,
															"scan.evaluate.latestDescription",
															"Metrics from the latest evaluation run for this job.",
														)}
													</CardDescription>
												</div>
												{isLoadingLatestEvaluation ? (
													<Loader2 className="size-4 animate-spin text-muted-foreground" />
												) : null}
											</div>
										</CardHeader>
										<CardContent>
											{latestEvaluation ? (
												<div className="grid gap-3 md:grid-cols-4">
													<div className="rounded-lg border p-3">
														<div className="text-sm text-muted-foreground">
															{scanT(t, "scan.field.status", "Status")}
														</div>
														<div className="font-medium capitalize">
															{latestEvaluation.status}
														</div>
													</div>
													<div className="rounded-lg border p-3">
														<div className="text-sm text-muted-foreground">
															{scanT(t, "scan.status.finished", "Finished")}
														</div>
														<div className="font-medium">
															{latestEvaluation.finishedAt ? (
																<DateTooltip date={latestEvaluation.finishedAt} />
															) : (
																"-"
															)}
														</div>
													</div>
													<div className="rounded-lg border p-3">
														<div className="text-sm text-muted-foreground">
															TP / FP / FN
														</div>
														<div className="font-medium tabular-nums">
															{String(
																getEvaluationResult(latestEvaluation)
																	?.truePositive ?? "-",
															)}
															{" / "}
															{String(
																getEvaluationResult(latestEvaluation)
																	?.falsePositive ?? "-",
															)}
															{" / "}
															{String(
																getEvaluationResult(latestEvaluation)
																	?.falseNegative ?? "-",
															)}
														</div>
													</div>
													<div className="rounded-lg border p-3">
														<div className="text-sm text-muted-foreground">
															Precision / Recall / F1
														</div>
														<div className="font-medium tabular-nums">
															{formatEvaluationMetric(
																getEvaluationResult(latestEvaluation)?.precision,
															)}
															{" / "}
															{formatEvaluationMetric(
																getEvaluationResult(latestEvaluation)?.recall,
															)}
															{" / "}
															{formatEvaluationMetric(
																getEvaluationResult(latestEvaluation)?.f1,
															)}
														</div>
													</div>
													{getEvaluationResult(latestEvaluation)?.summary ? (
														<div className="rounded-lg border p-3 md:col-span-4">
															<div className="text-sm text-muted-foreground">
																{scanT(t, "scan.field.summary", "Summary")}
															</div>
															<div className="font-medium">
																{String(
																	getEvaluationResult(latestEvaluation)?.summary,
																)}
															</div>
														</div>
													) : null}
													{latestEvaluation.errorMessage ? (
														<div className="rounded-lg border p-3 md:col-span-4">
															<div className="text-sm text-muted-foreground">
																{scanT(t, "scan.field.errorMessage", "Error")}
															</div>
															<div className="font-medium text-destructive break-all">
																{latestEvaluation.errorMessage}
															</div>
														</div>
													) : null}
												</div>
											) : (
												<div className="text-sm text-muted-foreground">
													{scanT(
														t,
														"scan.evaluate.empty",
														"No evaluation has been run for this job.",
													)}
												</div>
											)}
										</CardContent>
									</Card>
								</div>
							)}
						</TabsContent>

						<TabsContent value="candidates" className="pt-4">
							{isLoadingCandidates ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									{scanT(t, "scan.candidates.loading", "Loading candidates...")}
								</div>
							) : !candidates ||
								(!hasAnyCandidates &&
									!hasCandidateFilters &&
									candidates.total === 0) ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<FileSearch className="size-4" />
									{scanT(t, "scan.candidates.empty", "No candidates yet")}
								</div>
							) : (
								<div className="flex flex-col gap-3">
									<div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_220px_220px_220px]">
										<div className="relative">
											<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
											<input
												type="text"
												value={candidateQuery}
												onChange={(event) => {
													setCandidatePage(1);
													setCandidateQuery(event.target.value);
												}}
												placeholder={scanT(
													t,
													"scan.candidates.search",
													"Search candidates",
												)}
												className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
											/>
										</div>
										<Popover>
											<PopoverTrigger asChild>
												<Button variant="outline" className="justify-between">
													<span>
														{scanT(
															t,
															"scan.filters.analysisResult",
															"Analysis Result",
														)}
														{analysisFilters.length > 0
															? ` (${analysisFilters.length})`
															: ""}
													</span>
													<ChevronsUpDown className="size-4 text-muted-foreground" />
												</Button>
											</PopoverTrigger>
											<PopoverContent align="end" className="w-72 p-3">
												<div className="mb-3 flex items-center justify-between">
													<div className="text-sm font-medium">
														{scanT(
															t,
															"scan.filters.analysisResult",
															"Analysis Result",
														)}
													</div>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="h-auto px-2 py-1 text-xs"
														onClick={() => setAnalysisFilters([])}
													>
														{scanT(t, "scan.filters.clear", "Clear")}
													</Button>
												</div>
												<div className="space-y-2">
													{ANALYSIS_RESULT_OPTIONS.map((value) => (
														<label
															key={value}
															className="flex items-center gap-2 text-sm"
														>
															<Checkbox
																checked={analysisFilters.includes(value)}
																onCheckedChange={() =>
																	toggleAnalysisFilter(value)
																}
															/>
															<span>{formatAnalysisResultLabel(t, value)}</span>
														</label>
													))}
												</div>
											</PopoverContent>
										</Popover>
										<Popover>
											<PopoverTrigger asChild>
												<Button variant="outline" className="justify-between">
													<span>
														{scanT(t, "scan.filters.verifyResult", "Verify Result")}
														{verifyFilters.length > 0
															? ` (${verifyFilters.length})`
															: ""}
													</span>
													<ChevronsUpDown className="size-4 text-muted-foreground" />
												</Button>
											</PopoverTrigger>
											<PopoverContent align="end" className="w-72 p-3">
												<div className="mb-3 flex items-center justify-between">
													<div className="text-sm font-medium">
														{scanT(t, "scan.filters.verifyResult", "Verify Result")}
													</div>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="h-auto px-2 py-1 text-xs"
														onClick={() => setVerifyFilters([])}
													>
														{scanT(t, "scan.filters.clear", "Clear")}
													</Button>
												</div>
												<div className="space-y-2">
													{VERIFY_RESULT_OPTIONS.map((value) => (
														<label
															key={value}
															className="flex items-center gap-2 text-sm"
														>
															<Checkbox
																checked={verifyFilters.includes(value)}
																onCheckedChange={() =>
																	toggleVerifyFilter(value)
																}
															/>
															<span>{formatTruthResultLabel(t, value)}</span>
														</label>
													))}
												</div>
											</PopoverContent>
										</Popover>
										<Popover>
											<PopoverTrigger asChild>
												<Button variant="outline" className="justify-between">
													<span>
														{scanT(t, "scan.filters.triageResult", "Triage Result")}
														{triageFilters.length > 0
															? ` (${triageFilters.length})`
															: ""}
													</span>
													<ChevronsUpDown className="size-4 text-muted-foreground" />
												</Button>
											</PopoverTrigger>
											<PopoverContent align="end" className="w-72 p-3">
												<div className="mb-3 flex items-center justify-between">
													<div className="text-sm font-medium">
														{scanT(t, "scan.filters.triageResult", "Triage Result")}
													</div>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="h-auto px-2 py-1 text-xs"
														onClick={() => setTriageFilters([])}
													>
														{scanT(t, "scan.filters.clear", "Clear")}
													</Button>
												</div>
												<div className="space-y-2">
													{TRIAGE_RESULT_OPTIONS.map((value) => (
														<label
															key={value}
															className="flex items-center gap-2 text-sm"
														>
															<Checkbox
																checked={triageFilters.includes(value)}
																onCheckedChange={() =>
																	toggleTriageFilter(value)
																}
															/>
															<span>
																{scanT(
																	t,
																	`scan.triageResult.${value}`,
																	formatResultLabel(value),
																)}
															</span>
														</label>
													))}
												</div>
											</PopoverContent>
										</Popover>
									</div>
									{candidatePagination.totalItems === 0 ? (
										<div className="flex items-center gap-2 text-muted-foreground">
											<FileSearch className="size-4" />
											{scanT(
												t,
												"scan.candidates.noMatching",
												"No matching candidates",
											)}
										</div>
									) : (
										<>
											<div className="rounded-lg border">
												<div className="flex flex-col gap-3 border-b px-4 py-3 text-sm md:flex-row md:items-center md:justify-between">
													<div className="text-muted-foreground">
														{scanT(
															t,
															"scan.pagination.showing",
															"Showing {{start}}-{{end}} of {{total}}",
															{
																start: candidatePagination.startIndex + 1,
																end: candidatePagination.endIndex,
																total: candidatePagination.totalItems,
															},
														)}
														{selectedCandidateCount > 0
															? ` ${scanT(
																	t,
																	"scan.pagination.selected",
																	"({{count}} selected)",
																	{ count: selectedCandidateCount },
																)}`
															: ""}
													</div>
													<div className="flex flex-wrap items-center gap-2">
														<Button
															type="button"
															variant="outline"
															size="sm"
															disabled={
																selectedCandidateCount === 0 ||
																startCandidateReviewContainerMutation.isLoading
															}
															onClick={handleStartCandidateReviewContainer}
														>
															{startCandidateReviewContainerMutation.isLoading ? (
																<Loader2 className="mr-2 size-4 animate-spin" />
															) : (
																<SquareTerminal className="mr-2 size-4" />
															)}
															{scanT(
																t,
																startCandidateReviewContainerMutation.isLoading
																	? "scan.candidates.mountAndStartContainerStarting"
																	: "scan.candidates.mountAndStartContainer",
																startCandidateReviewContainerMutation.isLoading
																	? "Starting..."
																	: "Mount and Start Container",
															)}
														</Button>
														<Button
															type="button"
															variant="outline"
															size="sm"
															disabled={selectedCandidateCount === 0}
															onClick={() =>
																setIsCandidateExportDialogOpen(true)
															}
														>
															<Download className="mr-2 size-4" />
															{scanT(t, "scan.candidates.export", "Export")}
														</Button>
														<label className="text-muted-foreground">
															{scanT(t, "scan.pagination.pageSize", "Page size")}
														</label>
														<select
															value={candidatePageSize}
															onChange={(event) => {
																setCandidatePage(1);
																setCandidatePageSize(
																	Number.parseInt(event.target.value, 10) || 20,
																);
															}}
															className="h-9 rounded-md border border-input bg-background px-2 text-sm"
														>
															{[10, 20, 50, 100].map((size) => (
																<option key={size} value={size}>
																	{size}
																</option>
															))}
														</select>
														<Button
															type="button"
															variant="outline"
															size="sm"
															onClick={() =>
																setCandidatePage((current) =>
																	Math.max(1, current - 1),
																)
															}
															disabled={candidatePagination.page <= 1}
														>
															{scanT(t, "scan.pagination.previous", "Previous")}
														</Button>
														<div className="min-w-[96px] text-center text-muted-foreground">
															{scanT(
																t,
																"scan.pagination.page",
																"Page {{page}} / {{total}}",
																{
																	page: candidatePagination.page,
																	total: candidatePagination.totalPages,
																},
															)}
														</div>
														<Button
															type="button"
															variant="outline"
															size="sm"
															onClick={() =>
																setCandidatePage((current) =>
																	Math.min(
																		candidatePagination.totalPages,
																		current + 1,
																	),
																)
															}
															disabled={
																candidatePagination.page >=
																candidatePagination.totalPages
															}
														>
															{scanT(t, "scan.pagination.next", "Next")}
														</Button>
													</div>
												</div>
												<div className="overflow-x-auto">
													<table className="w-full text-sm">
														<thead className="border-b bg-muted/30 text-left">
															<tr>
																<th className="w-12 px-4 py-3 font-medium">
																	<Checkbox
																		aria-label={scanT(
																			t,
																			"scan.candidates.selectAllAria",
																			"Select all candidates on this page",
																		)}
																		checked={
																			areAllCurrentPageCandidatesSelected
																				? true
																				: areSomeCurrentPageCandidatesSelected
																					? "indeterminate"
																					: false
																		}
																		onClick={(event) => event.stopPropagation()}
																		onCheckedChange={
																			toggleCurrentPageCandidateSelection
																		}
																	/>
																</th>
																<th className="w-[10%] px-4 py-3 font-medium">
																	{scanT(t, "scan.field.status", "Status")}
																</th>
																<th className="w-[32%] px-4 py-3 font-medium">
																	<button
																		type="button"
																		onClick={() =>
																			toggleCandidateSort("candidate")
																		}
																		className="inline-flex items-center gap-1 hover:text-foreground"
																	>
																		<span>
																			{scanT(
																				t,
																				"scan.field.candidate",
																				"Candidate",
																			)}
																		</span>
																		<ChevronsUpDown className="size-3.5" />
																	</button>
																</th>
																<th className="w-[16%] px-4 py-3 font-medium">
																	<button
																		type="button"
																		onClick={() =>
																			toggleCandidateSort("analysis")
																		}
																		className="inline-flex items-center gap-1 hover:text-foreground"
																	>
																		<span>
																			{scanT(
																				t,
																				"scan.filters.analysisResult",
																				"Analysis Result",
																			)}
																		</span>
																		<ChevronsUpDown className="size-3.5" />
																	</button>
																</th>
																<th className="w-[14%] px-4 py-3 font-medium">
																	<button
																		type="button"
																		onClick={() =>
																			toggleCandidateSort("verify")
																		}
																		className="inline-flex items-center gap-1 hover:text-foreground"
																	>
																		<span>
																			{scanT(
																				t,
																				"scan.filters.verifyResult",
																				"Verify Result",
																			)}
																		</span>
																		<ChevronsUpDown className="size-3.5" />
																	</button>
																</th>
																<th className="w-[16%] px-4 py-3 font-medium">
																	{scanT(
																		t,
																		"scan.filters.triageResult",
																		"Triage Result",
																	)}
																</th>
																<th className="w-[13%] px-4 py-3 font-medium">
																	<button
																		type="button"
																		onClick={() =>
																			toggleCandidateSort(
																				"latestResultUpdatedAt",
																			)
																		}
																		className="inline-flex items-center gap-1 hover:text-foreground"
																	>
																		<span>
																			{scanT(
																				t,
																				"scan.field.latestResultUpdatedAt",
																				"Latest Update",
																			)}
																		</span>
																		<ChevronsUpDown className="size-3.5" />
																	</button>
																</th>
																<th className="w-[14%] px-4 py-3 font-medium">
																	<button
																		type="button"
																		onClick={() => toggleCandidateSort("score")}
																		className="inline-flex items-center gap-1 hover:text-foreground"
																	>
																		<span>{scanT(t, "scan.field.score", "Score")}</span>
																		<ChevronsUpDown className="size-3.5" />
																	</button>
																</th>
																<th className="w-[8%] px-4 py-3 font-medium">
																	{scanT(t, "scan.tasks.actions", "Actions")}
																</th>
															</tr>
														</thead>
														<tbody>
															{candidatePagination.items.map((candidate) => {
																const verificationTruthBadge =
																	getVerificationTruthBadge(
																		t,
																		candidate.latestVerificationResult?.result,
																	);
																const isTerminalCandidate =
																	RERUNNABLE_CANDIDATE_STATUSES.has(
																		candidate.status,
																	);
																const isReanalyzingCandidate =
																	reanalyzingCandidateId ===
																	buildCandidateReanalysisKey(candidate);
																const isSelectedCandidate =
																	selectedCandidateIds.has(
																		candidate.vulnerabilityCandidateId,
																	);
																const latestResultUpdate =
																	getCandidateLatestResultUpdate(candidate);
																return (
																	<tr
																		key={candidate.vulnerabilityCandidateId}
																		className={`border-b last:border-b-0 transition-colors hover:bg-muted/40 ${
																			isSelectedCandidate ? "bg-muted/40" : ""
																		}`}
																	>
																		<td className="px-4 py-3 align-top">
																			<Checkbox
																				aria-label={scanT(
																					t,
																					"scan.candidates.selectAria",
																					"Select candidate {{title}}",
																					{ title: candidate.title },
																				)}
																				checked={isSelectedCandidate}
																				onClick={(event) =>
																					event.stopPropagation()
																				}
																				onCheckedChange={() =>
																					toggleCandidateSelection(
																						candidate.vulnerabilityCandidateId,
																					)
																				}
																			/>
																		</td>
																		<td className="px-4 py-3 align-top text-xs text-muted-foreground capitalize">
																			<Link
																				href={buildCandidateDetailHref(
																					candidate,
																				)}
																				onClick={handleCandidateLinkClick}
																				className="block"
																			>
																				{formatScanStatusLabel(
																					t,
																					candidate.status,
																				)}
																			</Link>
																		</td>
																		<td className="px-4 py-3 align-top">
																			<Link
																				href={buildCandidateDetailHref(
																					candidate,
																				)}
																				onClick={handleCandidateLinkClick}
																				className="block"
																			>
																				<div className="font-medium">
																					{candidate.title}
																				</div>
																				<div className="mt-1 text-xs text-muted-foreground break-all">
																					{candidate.filePath || "-"}
																					{candidate.line
																						? `:${candidate.line}`
																						: ""}
																				</div>
																			</Link>
																		</td>
																		<td className="px-4 py-3 align-top">
																			<Link
																				href={buildCandidateDetailHref(
																					candidate,
																				)}
																				onClick={handleCandidateLinkClick}
																				className="block"
																			>
																				{candidate.latestAnalysisResult
																					?.result ? (
																					<Badge
																						variant="outline"
																						className={getAnalysisResultBadgeClassName(
																							candidate.latestAnalysisResult
																								.result,
																						)}
																					>
																						{getShortResultLabel(
																							t,
																							candidate.latestAnalysisResult
																								.result,
																						)}
																					</Badge>
																				) : (
																					<span className="text-xs text-muted-foreground">
																						-
																					</span>
																				)}
																			</Link>
																		</td>
																		<td className="px-4 py-3 align-top">
																			<Link
																				href={buildCandidateDetailHref(
																					candidate,
																				)}
																				onClick={handleCandidateLinkClick}
																				className="block"
																			>
																				{verificationTruthBadge ? (
																					<Badge
																						variant="outline"
																						className={
																							verificationTruthBadge.className
																						}
																					>
																						{verificationTruthBadge.label}
																					</Badge>
																				) : (
																					<span className="text-xs text-muted-foreground">
																						-
																					</span>
																				)}
																			</Link>
																		</td>
																		<td className="px-4 py-3 align-top">
																			<Link
																				href={buildCandidateDetailHref(
																					candidate,
																				)}
																				onClick={handleCandidateLinkClick}
																				className="block"
																			>
																				{candidate.latestTriageResult ? (
																					<Badge
																						variant="outline"
																						className={getTriageResultBadgeClassName(
																							candidate.latestTriageResult
																								.result,
																						)}
																					>
																						{getShortResultLabel(
																							t,
																							candidate.latestTriageResult
																								.result,
																						)}
																					</Badge>
																				) : (
																					<span className="text-xs text-muted-foreground">
																						-
																					</span>
																				)}
																			</Link>
																		</td>
																		<td className="px-4 py-3 align-top text-xs">
																			<Link
																				href={buildCandidateDetailHref(
																					candidate,
																				)}
																				onClick={handleCandidateLinkClick}
																				className="block"
																			>
																				{latestResultUpdate ? (
																					<>
																						<DateTooltip
																							date={latestResultUpdate.date}
																							className="text-xs"
																						/>
																						<div className="mt-1 text-muted-foreground">
																							{scanT(
																								t,
																								latestResultUpdate.stageKey,
																								latestResultUpdate.stageLabel,
																							)}
																						</div>
																					</>
																				) : (
																					<span className="text-muted-foreground">
																						-
																					</span>
																				)}
																			</Link>
																		</td>
																		<td className="px-4 py-3 align-top text-xs text-muted-foreground">
																			<Link
																				href={buildCandidateDetailHref(
																					candidate,
																				)}
																				onClick={handleCandidateLinkClick}
																				className="block"
																			>
																				{typeof candidate.score === "number"
																					? candidate.score.toFixed(1)
																					: "-"}
																			</Link>
																		</td>
																		<td className="px-4 py-3 align-top">
																			<Button
																				type="button"
																				variant="outline"
																				size="icon"
																				title={
																					isTerminalCandidate
																						? scanT(
																								t,
																								"scan.candidates.rerunAnalysis",
																								"Re-run analysis",
																							)
																						: scanT(
																								t,
																								"scan.candidates.rerunAnalysisDisabled",
																								"Analysis can be re-run after the candidate reaches a terminal state",
																							)
																				}
																				aria-label={
																					isTerminalCandidate
																						? scanT(
																								t,
																								"scan.candidates.rerunAnalysis",
																								"Re-run analysis",
																							)
																						: scanT(
																								t,
																								"scan.candidates.rerunAnalysisDisabled",
																								"Analysis can be re-run after the candidate reaches a terminal state",
																							)
																				}
																				disabled={
																					!isTerminalCandidate ||
																					isReanalyzingCandidate
																				}
																				onClick={() =>
																					handleAnalyzeCandidate(candidate)
																				}
																			>
																				{isReanalyzingCandidate ? (
																					<Loader2 className="size-4 animate-spin" />
																				) : (
																					<RefreshCw className="size-4" />
																				)}
																			</Button>
																		</td>
																	</tr>
																);
															})}
														</tbody>
													</table>
												</div>
											</div>
											<Dialog
												open={isCandidateExportDialogOpen}
												onOpenChange={setIsCandidateExportDialogOpen}
											>
												<DialogContent className="sm:max-w-xl">
													<DialogHeader>
														<DialogTitle>
															{scanT(
																t,
																"scan.candidates.exportTitle",
																"Export Candidates",
															)}
														</DialogTitle>
														<DialogDescription>
															{scanT(
																t,
																"scan.candidates.exportDescription",
																"Export {{count}} selected candidates from the current page.",
																{ count: selectedCandidateCount },
															)}
														</DialogDescription>
													</DialogHeader>
													<div className="space-y-4">
														<div className="flex items-center justify-between gap-3">
															<div>
																<div className="text-sm font-medium">
																	{scanT(t, "scan.candidates.exportFields", "Fields")}
																</div>
																<div className="text-xs text-muted-foreground">
																	{scanT(
																		t,
																		"scan.candidates.exportFieldsDescription",
																		"Choose the fields included in the generated JSON.",
																	)}
																</div>
															</div>
															<Button
																type="button"
																variant="ghost"
																size="sm"
																className="h-auto px-2 py-1 text-xs"
																onClick={() =>
																	setCandidateExportFields(
																		candidateExportFields.length ===
																			CANDIDATE_EXPORT_FIELDS.length
																			? []
																			: [...DEFAULT_CANDIDATE_EXPORT_FIELDS],
																	)
																}
															>
																{candidateExportFields.length ===
																CANDIDATE_EXPORT_FIELDS.length
																	? scanT(t, "scan.filters.clear", "Clear")
																	: scanT(
																			t,
																			"scan.candidates.selectAll",
																			"Select all",
																		)}
															</Button>
														</div>
														<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
															{CANDIDATE_EXPORT_FIELDS.map((field) => (
																<label
																	key={field.key}
																	className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
																>
																	<Checkbox
																		checked={selectedExportFieldSet.has(
																			field.key,
																		)}
																		onCheckedChange={() =>
																			toggleCandidateExportField(field.key)
																		}
																	/>
																	<span>
																		{getCandidateExportFieldLabel(t, field)}
																	</span>
																</label>
															))}
														</div>
														{!hasSelectedExportFields ? (
															<div className="text-xs text-destructive">
																{scanT(
																	t,
																	"scan.candidates.exportNoFields",
																	"Select at least one field to export.",
																)}
															</div>
														) : null}
													</div>
													<DialogFooter>
														<Button
															type="button"
															variant="outline"
															onClick={copySelectedCandidatesJson}
															disabled={
																selectedCandidateCount === 0 ||
																!hasSelectedExportFields
															}
														>
															<Clipboard className="mr-2 size-4" />
															{scanT(t, "scan.candidates.copyJson", "Copy JSON")}
														</Button>
														<Button
															type="button"
															onClick={downloadSelectedCandidatesJson}
															disabled={
																selectedCandidateCount === 0 ||
																!hasSelectedExportFields
															}
														>
															<Download className="mr-2 size-4" />
															{scanT(
																t,
																"scan.candidates.downloadJson",
																"Download JSON",
															)}
														</Button>
													</DialogFooter>
												</DialogContent>
											</Dialog>
										</>
									)}
								</div>
							)}
						</TabsContent>

						<TabsContent value="monitoring" className="pt-4">
							<ScanMonitoring mode="job" scanJobId={scanJobId} />
						</TabsContent>

						<TabsContent value="files" className="pt-4">
							<div className="rounded-lg border">
								<div className="border-b px-4 py-3">
									<div className="font-medium">
										{scanT(t, "scan.files.title", "Files")}
									</div>
									<div className="text-sm text-muted-foreground">
										{scanT(
											t,
											"scan.files.jobDescription",
											"Browse scan job context files.",
										)}
									</div>
								</div>
								<div className="grid min-h-[65vh] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
									<div className="border-b lg:border-b-0 lg:border-r">
										<LazyFileTree
											rootItems={
												directoryCache[ROOT_DIRECTORY_KEY]?.items || []
											}
											rootStatus={
												directoryCache[ROOT_DIRECTORY_KEY]?.status ||
												(rootDirectoryQuery.isLoading ? "loading" : "idle")
											}
											expandedDirectories={expandedDirectories}
											selectedFilePath={selectedFilePath}
											directoryCache={directoryCache}
											onToggleDirectory={handleToggleDirectory}
											onSelectFile={setSelectedFilePath}
										/>
									</div>

									<div className="min-w-0">
										<div className="border-b px-4 py-3">
											<div className="flex items-center gap-2 text-sm text-muted-foreground">
												<FileIcon className="size-4" />
												<span className="truncate">
													{selectedFile?.relativePath ||
														selectedFilePath ||
														scanT(
															t,
															"scan.files.noFileSelected",
															"No file selected",
														)}
												</span>
											</div>
										</div>
										<div className="max-h-[calc(65vh-49px)] overflow-auto px-4 py-3">
											{!selectedFilePath ? (
												<div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
													<FileIcon className="size-6" />
													{scanT(
														t,
														"scan.files.noFileSelected",
														"No file selected",
													)}
												</div>
											) : isLoadingSelectedFile ? (
												<div className="flex min-h-[280px] items-center justify-center gap-2 text-muted-foreground">
													<Loader2 className="size-4 animate-spin" />
													{scanT(t, "scan.files.loadingFile", "Loading file...")}
												</div>
											) : (
												<pre className="whitespace-pre-wrap break-words font-mono text-sm">
													{selectedFile?.content ||
														scanT(t, "scan.files.emptyFile", "(empty)")}
												</pre>
											)}
										</div>
									</div>
								</div>
							</div>
						</TabsContent>

						<TabsContent value="tasks" className="pt-4">
							<div className="flex flex-col gap-4">
								<div className="rounded-lg border">
									<div className="border-b px-4 py-3">
										<div className="font-medium">
											{scanT(t, "scan.tasks.queues", "阶段任务队列")}
										</div>
										<div className="text-sm text-muted-foreground">
											{scanT(
												t,
												"scan.tasks.queuesDescription",
												"此任务中每个队列的阶段任务进度。",
											)}
										</div>
									</div>
									<div className="overflow-x-auto">
										{statusViewError ? (
											<div className="px-4 py-6 text-sm text-destructive">
												{scanT(
													t,
													"scan.tasks.queueLoadError",
													"加载队列状态失败。",
												)}
											</div>
										) : !statusView ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												{scanT(
													t,
													"scan.tasks.queueLoading",
													"正在加载队列状态...",
												)}
											</div>
										) : queuePendingCounts.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												{scanT(t, "scan.tasks.noQueues", "暂无阶段任务队列")}
											</div>
										) : (
											<table className="w-full text-sm">
												<thead className="border-b bg-muted/30 text-left">
													<tr>
														<th className="w-[46%] px-4 py-3 font-medium">
															{scanT(t, "scan.tasks.queue", "队列")}
														</th>
														<th className="w-[18%] px-4 py-3 text-right font-medium">
															{scanT(t, "scan.status.queued", "排队中")}
														</th>
														<th className="w-[18%] px-4 py-3 text-right font-medium">
															{scanT(t, "scan.status.running", "运行中")}
														</th>
														<th className="w-[18%] px-4 py-3 text-right font-medium">
															{scanT(t, "scan.tasks.done", "完成")}
														</th>
													</tr>
												</thead>
												<tbody>
													{queuePendingCounts.map((queue) => {
														const metrics = getQueueTaskMetrics(queue);
														return (
															<tr
																key={queue.id}
																className="border-b last:border-b-0"
															>
																<td className="w-[46%] px-4 py-3 align-top font-medium">
																	{formatScanStageLabel(t, queue.stageName || queue.title)}
																</td>
																<td
																	className="w-[18%] px-4 py-3 text-right align-top"
																	title={metrics.title}
																>
																	<span className="tabular-nums">
																		{metrics.queued}
																	</span>
																</td>
																<td
																	className="w-[18%] px-4 py-3 text-right align-top"
																	title={metrics.title}
																>
																	<RunningCapacityBars
																		running={metrics.running}
																		limit={metrics.concurrencyLimit}
																	/>
																</td>
																<td
																	className="w-[18%] px-4 py-3 text-right align-top"
																	title={metrics.title}
																>
																	<span className="tabular-nums">
																		{metrics.done}
																	</span>
																</td>
															</tr>
														);
													})}
												</tbody>
											</table>
										)}
									</div>
								</div>

								<div className="rounded-lg border">
									<div className="border-b px-4 py-3">
										<div className="font-medium">
											{scanT(t, "scan.tasks.running", "运行中阶段任务")}
										</div>
										<div className="text-sm text-muted-foreground">
											{scanT(
												t,
												"scan.tasks.runningDescription",
												"此任务中所有运行中的扫描、分析和验证 agent。",
											)}
										</div>
									</div>
									{statusView && sortedInProgressTasks.length > 0 ? (
										<div className="flex flex-col gap-3 border-b px-4 py-3 text-sm xl:flex-row xl:items-center xl:justify-between">
											<div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
												<div className="relative">
													<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
													<input
														type="text"
														value={taskSearchQuery}
														onChange={(event) => {
															setTaskSearchQuery(event.target.value);
															setRunningTaskPage(1);
															setFinishedTaskPage(1);
														}}
														placeholder={scanT(t, "scan.tasks.search", "搜索阶段任务")}
														className="flex h-9 w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
													/>
												</div>
												<select
													value={runningTaskStageFilter}
													onChange={(event) => {
														setRunningTaskStageFilter(event.target.value);
														setRunningTaskPage(1);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													<option value="all">
														{scanT(t, "scan.filters.allStages", "全部阶段")}
													</option>
													{taskStageOptions.map((stage) => (
														<option key={stage} value={stage}>
															{getTaskStageLabel(t, stage)}
														</option>
													))}
												</select>
											</div>
											<div className="flex flex-wrap items-center gap-2">
												{selectedFinishedTaskCount > 0 ? (
													<>
														<div className="text-muted-foreground">
															{scanT(
																t,
																"scan.tasks.selectedFinished",
																"{{count}} tasks selected",
																{ count: selectedFinishedTaskCount },
															)}
														</div>
														<Button
															type="button"
															variant="outline"
															size="sm"
															onClick={() =>
																void handleRerunSelectedFinishedTasks()
															}
															disabled={
																rerunTaskMutation.isLoading ||
																bulkRerunningTaskIds.size > 0
															}
														>
															{bulkRerunningTaskIds.size > 0 ? (
																<Loader2 className="mr-2 size-4 animate-spin" />
															) : (
																<RefreshCw className="mr-2 size-4" />
															)}
															{scanT(
																t,
																"scan.task.rerunSelected",
																"Rerun selected",
															)}
														</Button>
													</>
												) : null}
												<div className="text-muted-foreground">
													{scanT(
														t,
														"scan.pagination.showing",
														"显示 {{start}}-{{end}} / {{total}}",
														{
															start:
																runningTaskPagination.totalItems > 0
																	? runningTaskPagination.startIndex + 1
																	: 0,
															end: runningTaskPagination.endIndex,
															total: runningTaskPagination.totalItems,
														},
													)}
												</div>
												<span className="text-muted-foreground">
													{scanT(t, "scan.pagination.pageSize", "每页数量")}
												</span>
												<select
													value={runningTaskPageSize}
													onChange={(event) => {
														setRunningTaskPage(1);
														setRunningTaskPageSize(
															Number.parseInt(event.target.value, 10) || 10,
														);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													{TASK_PAGE_SIZE_OPTIONS.map((size) => (
														<option key={size} value={size}>
															{size}
														</option>
													))}
												</select>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														setRunningTaskPage((current) =>
															Math.max(1, current - 1),
														)
													}
													disabled={runningTaskPagination.page <= 1}
												>
													{scanT(t, "scan.pagination.previous", "上一页")}
												</Button>
												<div className="min-w-[88px] text-center text-muted-foreground">
													{scanT(t, "scan.pagination.page", "第 {{page}} / {{total}} 页", {
														page: runningTaskPagination.page,
														total: runningTaskPagination.totalPages,
													})}
												</div>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														setRunningTaskPage((current) =>
															Math.min(
																runningTaskPagination.totalPages,
																current + 1,
															),
														)
													}
													disabled={
														runningTaskPagination.page >=
														runningTaskPagination.totalPages
													}
												>
													{scanT(t, "scan.pagination.next", "下一页")}
												</Button>
											</div>
										</div>
									) : null}
									<div className="overflow-x-auto">
										{!statusView || sortedInProgressTasks.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												{scanT(t, "scan.tasks.noRunning", "暂无运行中阶段任务")}
											</div>
										) : filteredInProgressTasks.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												{scanT(t, "scan.tasks.noMatching", "没有匹配的阶段任务")}
											</div>
										) : (
											<table className="w-full text-sm">
												<thead className="border-b bg-muted/30 text-left">
													<tr>
														<th className="w-[22%] px-4 py-3 font-medium">
															{scanT(t, "scan.monitoring.task", "阶段任务")}
														</th>
														<th className="w-[10%] px-4 py-3 font-medium">
															{scanT(t, "scan.field.stage", "阶段")}
														</th>
														<th className="w-[10%] px-4 py-3 font-medium">
															{scanT(t, "scan.fuzzing.runtime", "运行时长")}
														</th>
														<th className="w-[48%] px-4 py-3 font-medium">
															{scanT(t, "scan.tasks.currentActivity", "当前活动")}
														</th>
														<th className="w-[10%] px-4 py-3 font-medium">
															{scanT(t, "scan.tasks.actions", "操作")}
														</th>
													</tr>
												</thead>
												<tbody>
													{runningTaskPagination.items.map((task) => {
														const displayTask = getTaskListDisplay(t, task);
														return (
															<tr
															key={task.id}
															tabIndex={0}
															aria-label={scanT(
																t,
																"scan.task.openAria",
																"打开阶段任务 {{title}}",
																{ title: displayTask.title },
															)}
															onClick={(event) =>
																handleTaskRowClick(event, task.taskId)
															}
															onKeyDown={(event) =>
																handleTaskRowKeyDown(event, task.taskId)
															}
															className="cursor-pointer border-b transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none last:border-b-0"
														>
															<td className="w-[22%] px-4 py-3 align-top">
																<div className="line-clamp-2 font-medium">
																	{displayTask.title}
																</div>
																<div className="text-xs text-muted-foreground break-all">
																	{displayTask.subtitle}
																</div>
															</td>
															<td className="w-[10%] px-4 py-3 align-top capitalize">
																{getTaskStageLabel(t, task.stage)}
															</td>
															<td className="w-[10%] whitespace-nowrap px-4 py-3 align-top tabular-nums">
																{formatTaskRuntime(
																	task.startedAt,
																	runtimeNowMs,
																)}
															</td>
															<td className="w-[48%] px-4 py-3 align-top">
																<LiveTaskActivityBadge
																	activity={
																		activitiesByTaskId[task.taskId] ||
																		idleSandboxAgentActivity
																	}
																	isConnected={activityConnectedTaskIds.has(
																		task.taskId,
																	)}
																/>
															</td>
															<td
																className="w-[10%] px-4 py-3 align-top"
																data-task-row-action
															>
																<div className="flex items-center gap-2">
																	<LiveTaskActivityButton
																		taskId={task.taskId}
																		title={displayTask.title}
																		subtitle={displayTask.subtitle}
																		activity={
																			activitiesByTaskId[task.taskId] ||
																			idleSandboxAgentActivity
																		}
																		variant="outline"
																		size="icon"
																		iconOnly
																	/>
																	<LiveTaskTextButton
																		taskId={task.taskId}
																		title={displayTask.title}
																		subtitle={displayTask.subtitle}
																		variant="outline"
																		size="icon"
																		iconOnly
																	/>
																</div>
															</td>
															</tr>
														);
													})}
												</tbody>
											</table>
										)}
									</div>
								</div>

								<div className="rounded-lg border">
									<div className="border-b px-4 py-3">
										<div className="font-medium">
											{scanT(t, "scan.tasks.finished", "已完成阶段任务")}
										</div>
										<div className="text-sm text-muted-foreground">
											{scanT(
												t,
												"scan.tasks.finishedDescription",
												"此任务中已完成、失败和已取消的阶段任务。",
											)}
										</div>
									</div>
									{terminalTasks &&
									(terminalTasks.total > 0 || hasFinishedTaskFilters) ? (
										<div className="flex flex-col gap-3 border-b px-4 py-3 text-sm xl:flex-row xl:items-center xl:justify-between">
											<div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_180px_180px]">
												<div className="relative">
													<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
													<input
														type="text"
														value={taskSearchQuery}
														onChange={(event) => {
															setTaskSearchQuery(event.target.value);
															setRunningTaskPage(1);
															setFinishedTaskPage(1);
														}}
														placeholder={scanT(t, "scan.tasks.search", "搜索阶段任务")}
														className="flex h-9 w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
													/>
												</div>
												<select
													value={finishedTaskStageFilter}
													onChange={(event) => {
														setFinishedTaskStageFilter(event.target.value);
														setFinishedTaskPage(1);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													<option value="all">
														{scanT(t, "scan.filters.allStages", "全部阶段")}
													</option>
													{taskStageOptions.map((stage) => (
														<option key={stage} value={stage}>
															{getTaskStageLabel(t, stage)}
														</option>
													))}
												</select>
												<select
													value={taskStatusFilter}
													onChange={(event) => {
														setTaskStatusFilter(event.target.value);
														setFinishedTaskPage(1);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													<option value="all">
														{scanT(t, "scan.filters.allStatuses", "全部状态")}
													</option>
													{TERMINAL_TASK_STATUS_OPTIONS.map((status) => (
														<option key={status} value={status}>
															{getTaskStatusLabel(t, status)}
														</option>
													))}
												</select>
											</div>
											<div className="flex flex-wrap items-center gap-2">
												<div className="text-muted-foreground">
													{scanT(
														t,
														"scan.pagination.showing",
														"显示 {{start}}-{{end}} / {{total}}",
														{
															start:
																finishedTaskPagination.totalItems > 0
																	? finishedTaskPagination.startIndex + 1
																	: 0,
															end: finishedTaskPagination.endIndex,
															total: finishedTaskPagination.totalItems,
														},
													)}
												</div>
												<span className="text-muted-foreground">
													{scanT(t, "scan.pagination.pageSize", "每页数量")}
												</span>
												<select
													value={finishedTaskPageSize}
													onChange={(event) => {
														setFinishedTaskPage(1);
														setFinishedTaskPageSize(
															Number.parseInt(event.target.value, 10) || 20,
														);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													{TASK_PAGE_SIZE_OPTIONS.map((size) => (
														<option key={size} value={size}>
															{size}
														</option>
													))}
												</select>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														setFinishedTaskPage((current) =>
															Math.max(1, current - 1),
														)
													}
													disabled={finishedTaskPagination.page <= 1}
												>
													{scanT(t, "scan.pagination.previous", "上一页")}
												</Button>
												<div className="min-w-[88px] text-center text-muted-foreground">
													{scanT(
														t,
														"scan.pagination.page",
														"第 {{page}} / {{total}} 页",
														{
															page: finishedTaskPagination.page,
															total: finishedTaskPagination.totalPages,
														},
													)}
												</div>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														setFinishedTaskPage((current) =>
															Math.min(
																finishedTaskPagination.totalPages,
																current + 1,
															),
														)
													}
													disabled={
														finishedTaskPagination.page >=
														finishedTaskPagination.totalPages
													}
												>
													{scanT(t, "scan.pagination.next", "下一页")}
												</Button>
											</div>
										</div>
									) : null}
									<div className="overflow-x-auto">
										{isLoadingTerminalTasks ? (
											<div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
												<Loader2 className="size-4 animate-spin" />
												{scanT(
													t,
													"scan.tasks.loadingFinished",
													"正在加载已完成阶段任务...",
												)}
											</div>
										) : !terminalTasks ||
											(terminalTasks.total === 0 && !hasFinishedTaskFilters) ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												{scanT(t, "scan.tasks.noFinished", "暂无已完成阶段任务")}
											</div>
										) : terminalTasks.total === 0 ||
											finishedTaskPagination.items.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												{scanT(t, "scan.tasks.noMatching", "没有匹配的阶段任务")}
											</div>
										) : (
											<table className="w-full text-sm">
												<thead className="border-b bg-muted/30 text-left">
													<tr>
														<th className="w-12 px-4 py-3 font-medium">
															<Checkbox
																aria-label={scanT(
																	t,
																	"scan.tasks.selectAllFinishedAria",
																	"Select rerunnable tasks on this page",
																)}
																checked={
																	areAllCurrentPageFinishedTasksSelected
																		? true
																		: areSomeCurrentPageFinishedTasksSelected
																			? "indeterminate"
																			: false
																}
																disabled={!hasCurrentPageRerunnableFinishedTasks}
																onClick={(event) => event.stopPropagation()}
																onCheckedChange={
																	toggleCurrentPageFinishedTaskSelection
																}
															/>
														</th>
														<th className="w-[21%] px-4 py-3 font-medium">
															{scanT(t, "scan.monitoring.task", "阶段任务")}
														</th>
														<th className="w-[9%] px-4 py-3 font-medium">
															{scanT(t, "scan.field.stage", "阶段")}
														</th>
														<th className="w-[9%] px-4 py-3 font-medium">
															{scanT(t, "scan.field.status", "状态")}
														</th>
														<th className="w-[11%] px-4 py-3 font-medium">
															{scanT(t, "scan.field.started", "开始时间")}
														</th>
														<th className="w-[11%] px-4 py-3 font-medium">
															{scanT(t, "scan.field.completed", "完成时间")}
														</th>
														<th className="w-[29%] px-4 py-3 font-medium">
															{scanT(t, "scan.task.tabs.details", "详情")}
														</th>
														<th className="w-[8%] px-4 py-3 font-medium">
															{scanT(t, "scan.tasks.actions", "操作")}
														</th>
													</tr>
												</thead>
												<tbody>
													{finishedTaskPagination.items.map((task) => {
														const canRerunTask = RERUNNABLE_TASK_STATUSES.has(
															task.status,
														);
														const isRerunningTask =
															rerunningTaskId === task.taskId ||
															bulkRerunningTaskIds.has(task.taskId);
														const isSelectedFinishedTask =
															selectedFinishedTaskIds.has(task.taskId);
														const displayTask = getTaskListDisplay(t, task);
														return (
															<tr
																key={task.id}
																role="link"
																tabIndex={0}
																aria-label={scanT(
																	t,
																	"scan.task.openAria",
																	"打开阶段任务 {{title}}",
																	{ title: displayTask.title },
																)}
																onClick={() =>
																	void router.push(
																		buildTaskDetailHref(task.taskId),
																	)
																}
																onKeyDown={(event) =>
																	handleTaskRowKeyDown(event, task.taskId)
																}
																className="cursor-pointer border-b transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none last:border-b-0"
															>
																<td className="w-12 px-4 py-3 align-top">
																	<Checkbox
																		aria-label={scanT(
																			t,
																			"scan.tasks.selectFinishedAria",
																			"Select task {{title}}",
																			{ title: displayTask.title },
																		)}
																		checked={isSelectedFinishedTask}
																		disabled={
																			!canRerunTask ||
																			bulkRerunningTaskIds.size > 0
																		}
																		onClick={(event) => event.stopPropagation()}
																		onCheckedChange={() =>
																			toggleFinishedTaskSelection(task.taskId)
																		}
																	/>
																</td>
																<td className="w-[21%] px-4 py-3 align-top">
																	<div className="line-clamp-2 font-medium">
																		{displayTask.title}
																	</div>
																	<div className="text-xs text-muted-foreground break-all">
																		{displayTask.subtitle}
																	</div>
																</td>
																<td className="w-[9%] px-4 py-3 align-top capitalize">
																	{getTaskStageLabel(t, task.stage)}
																</td>
																<td className="w-[9%] px-4 py-3 align-top">
																	<Badge
																		variant="outline"
																		className={getTaskStatusBadgeClassName(
																			task.status,
																		)}
																	>
																		{getTaskStatusLabel(t, task.status)}
																	</Badge>
																</td>
																<td className="w-[11%] whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">
																	{task.startedAt ? (
																		<DateTooltip date={task.startedAt} />
																	) : (
																		"-"
																	)}
																</td>
																<td className="w-[11%] whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">
																	{task.completedAt ? (
																		<DateTooltip date={task.completedAt} />
																	) : (
																		"-"
																	)}
																</td>
																<td className="w-[29%] px-4 py-3 align-top text-xs text-muted-foreground">
																	<div className="line-clamp-3 break-words">
																		{task.errorMessage || "-"}
																	</div>
																</td>
																<td className="w-[8%] px-4 py-3 align-top">
																	<div className="flex items-center gap-2">
																		<Button
																			type="button"
																			variant="outline"
																			size="icon"
																			title={
																				canRerunTask
																					? scanT(t, "scan.task.rerunTask", "重新运行阶段任务")
																					: scanT(
																							t,
																							"scan.task.rerunDisabled",
																							"阶段任务到达终态后才能重新运行",
																						)
																			}
																			aria-label={
																				canRerunTask
																					? scanT(t, "scan.task.rerunTask", "重新运行阶段任务")
																					: scanT(
																							t,
																							"scan.task.rerunDisabled",
																							"阶段任务到达终态后才能重新运行",
																						)
																			}
																			disabled={
																				!canRerunTask ||
																				isRerunningTask ||
																				rerunTaskMutation.isLoading
																			}
																			onClick={(event) => {
																				event.stopPropagation();
																				void handleRerunTask(task.taskId);
																			}}
																		>
																			{isRerunningTask ? (
																				<Loader2 className="size-4 animate-spin" />
																			) : (
																				<RefreshCw className="size-4" />
																			)}
																		</Button>
																	</div>
																</td>
															</tr>
														);
													})}
												</tbody>
											</table>
										)}
									</div>
								</div>
							</div>
						</TabsContent>
					</Tabs>
					<Dialog open={isEvaluateDialogOpen} onOpenChange={setIsEvaluateDialogOpen}>
						<DialogContent className="sm:max-w-2xl">
							<DialogHeader>
								<DialogTitle>
									{scanT(t, "scan.evaluate.title", "Evaluate")}
								</DialogTitle>
								<DialogDescription>
									{scanT(
										t,
										"scan.evaluate.dialogDescription",
										"Run a one-off evaluation using these settings. Changes here do not update application defaults.",
									)}
								</DialogDescription>
							</DialogHeader>
							<div className="grid gap-4">
								<div className="grid gap-2">
									<label
										htmlFor="run-evaluate-agent-profile"
										className="text-sm font-medium"
									>
										{scanT(
											t,
											"scan.evaluate.agentProfile",
											"Agent Profile",
										)}
									</label>
									<Select
										value={evaluateAgentProfileIdDraft}
										onValueChange={setEvaluateAgentProfileIdDraft}
									>
										<SelectTrigger id="run-evaluate-agent-profile">
											<SelectValue placeholder="Select an agent profile" />
										</SelectTrigger>
										<SelectContent>
											{enabledAgentProfiles.map((profile) => (
												<SelectItem
													key={profile.agentProfileId}
													value={profile.agentProfileId}
												>
													{profile.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="grid gap-2">
									<label
										htmlFor="run-evaluate-ground-truth-path"
										className="text-sm font-medium"
									>
										{scanT(
											t,
											"scan.evaluate.groundTruthPath",
											"Ground Truth Path",
										)}
									</label>
									<Input
										id="run-evaluate-ground-truth-path"
										value={evaluateGroundTruthPathDraft}
										onChange={(event) =>
											setEvaluateGroundTruthPathDraft(
												event.currentTarget.value,
											)
										}
										placeholder="/workspace/repo/ground_truth.json"
									/>
									<p className="text-xs text-muted-foreground">
										{scanT(
											t,
											"scan.evaluate.groundTruthHelp",
											"Use an absolute path inside the evaluation container.",
										)}
									</p>
								</div>
							</div>
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => setIsEvaluateDialogOpen(false)}
								>
									{scanT(t, "scan.dialog.cancel", "Cancel")}
								</Button>
								<Button
									type="button"
									disabled={startEvaluationMutation.isLoading}
									onClick={async () => {
										if (!evaluateAgentProfileIdDraft) {
											toast.error(
												scanT(
													t,
													"scan.evaluate.agentProfileRequired",
													"Agent profile is required",
												),
											);
											return;
										}
										const groundTruthPath =
											evaluateGroundTruthPathDraft.trim();
										if (!groundTruthPath.startsWith("/")) {
											toast.error(
												"Ground truth path must be an absolute container path",
											);
											return;
										}
										try {
											await startEvaluationMutation.mutateAsync({
												scanJobId,
												configSnapshot: {
													agentProfileId: evaluateAgentProfileIdDraft,
													groundTruthPath,
												},
											});
											setIsEvaluateDialogOpen(false);
											toast.success(
												scanT(
													t,
													"scan.evaluate.startedToast",
													"Evaluation started",
												),
											);
											await utils.scan.latestEvaluation.invalidate({
												scanJobId,
											});
										} catch (error) {
											toast.error(
												error instanceof Error
													? error.message
													: scanT(
															t,
															"scan.evaluate.startError",
															"Failed to start evaluation",
														),
											);
										}
									}}
								>
									{startEvaluationMutation.isLoading ? (
										<>
											<Loader2 className="mr-2 size-4 animate-spin" />
											{scanT(t, "scan.evaluate.starting", "Starting...")}
										</>
									) : (
										<>
											<ClipboardCheck className="mr-2 size-4" />
											{scanT(t, "scan.evaluate.run", "Run Evaluate")}
										</>
									)}
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
					<div className="pt-6">
						<Link
							className="text-sm text-muted-foreground underline"
							href={`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`}
						>
							{scanT(t, "scan.job.backToJobs", "Back to Jobs")}
						</Link>
					</div>
				</CardContent>
			</Card>
		</div>
	);
};
